"""SQLite cursor, nonce and durable outbox for crash-safe delivery."""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class OutboxJob:
    room: str
    request_seq: int
    request_did: str
    text: str
    nonce: int
    delivered: bool


@dataclass(frozen=True, slots=True)
class ScheduledJob:
    room: str
    job_key: str
    text: str
    nonce: int
    delivered: bool


class AgentState:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=FULL")
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS outbox (
                room TEXT NOT NULL,
                request_seq INTEGER NOT NULL,
                request_did TEXT NOT NULL,
                text TEXT NOT NULL,
                nonce INTEGER NOT NULL,
                delivered INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (room, request_seq)
            );
            CREATE TABLE IF NOT EXISTS scheduled_outbox (
                room TEXT NOT NULL,
                job_key TEXT NOT NULL,
                text TEXT NOT NULL,
                nonce INTEGER NOT NULL,
                delivered INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (room, job_key)
            );
            """
        )
        self._db.commit()

    def close(self) -> None:
        self._db.close()

    def __enter__(self) -> AgentState:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _integer(self, key: str) -> int:
        row = self._db.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return int(row["value"]) if row else 0

    def cursor(self, room: str) -> int:
        return self._integer(f"cursor:{room}")

    def advance_cursor(self, room: str, sequence: int) -> int:
        current = self.cursor(room)
        next_value = max(current, sequence)
        with self._db:
            self._db.execute(
                "INSERT INTO meta(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (f"cursor:{room}", str(next_value)),
            )
        return next_value

    @staticmethod
    def _job(row: sqlite3.Row) -> OutboxJob:
        return OutboxJob(
            room=row["room"],
            request_seq=row["request_seq"],
            request_did=row["request_did"],
            text=row["text"],
            nonce=row["nonce"],
            delivered=bool(row["delivered"]),
        )

    def get_job(self, room: str, request_seq: int) -> OutboxJob | None:
        row = self._db.execute(
            "SELECT * FROM outbox WHERE room = ? AND request_seq = ?", (room, request_seq)
        ).fetchone()
        return self._job(row) if row else None

    def prepare_job(self, room: str, request_seq: int, request_did: str, text: str) -> OutboxJob:
        existing = self.get_job(room, request_seq)
        if existing:
            return existing
        with self._db:
            nonce = self._next_nonce(room)
            self._db.execute(
                "INSERT INTO outbox(room, request_seq, request_did, text, nonce) "
                "VALUES(?, ?, ?, ?, ?)",
                (room, request_seq, request_did, text, nonce),
            )
        job = self.get_job(room, request_seq)
        if job is None:
            raise RuntimeError("failed to persist outbox job")
        return job

    def _next_nonce(self, room: str) -> int:
        key = f"nonce:{room}"
        last_nonce = self._integer(key)
        nonce = max(last_nonce + 1, time.time_ns() // 1_000_000)
        if nonce >= 10**19:
            raise OverflowError("Technocore nonce exhausted")
        self._db.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, str(nonce)),
        )
        return nonce

    def mark_delivered(self, room: str, request_seq: int) -> None:
        with self._db:
            self._db.execute(
                "UPDATE outbox SET delivered = 1 WHERE room = ? AND request_seq = ?",
                (room, request_seq),
            )

    @staticmethod
    def _scheduled_job(row: sqlite3.Row) -> ScheduledJob:
        return ScheduledJob(
            room=row["room"],
            job_key=row["job_key"],
            text=row["text"],
            nonce=row["nonce"],
            delivered=bool(row["delivered"]),
        )

    def get_scheduled_job(self, room: str, job_key: str) -> ScheduledJob | None:
        row = self._db.execute(
            "SELECT * FROM scheduled_outbox WHERE room = ? AND job_key = ?", (room, job_key)
        ).fetchone()
        return self._scheduled_job(row) if row else None

    def prepare_scheduled_job(self, room: str, job_key: str, text: str) -> ScheduledJob:
        existing = self.get_scheduled_job(room, job_key)
        if existing:
            return existing
        with self._db:
            nonce = self._next_nonce(room)
            self._db.execute(
                "INSERT INTO scheduled_outbox(room, job_key, text, nonce) VALUES(?, ?, ?, ?)",
                (room, job_key, text, nonce),
            )
        job = self.get_scheduled_job(room, job_key)
        if job is None:
            raise RuntimeError("failed to persist scheduled outbox job")
        return job

    def mark_scheduled_delivered(self, room: str, job_key: str) -> None:
        with self._db:
            self._db.execute(
                "UPDATE scheduled_outbox SET delivered = 1 WHERE room = ? AND job_key = ?",
                (room, job_key),
            )

    def pending_jobs(self, room: str, limit: int = 50) -> list[OutboxJob]:
        rows = self._db.execute(
            "SELECT * FROM outbox WHERE room = ? AND delivered = 0 ORDER BY request_seq LIMIT ?",
            (room, limit),
        ).fetchall()
        return [self._job(row) for row in rows]

    def pending_scheduled_jobs(self, room: str, limit: int = 50) -> list[ScheduledJob]:
        rows = self._db.execute(
            "SELECT * FROM scheduled_outbox WHERE room = ? AND delivered = 0 "
            "ORDER BY job_key LIMIT ?",
            (room, limit),
        ).fetchall()
        return [self._scheduled_job(row) for row in rows]
