"""Mailbox command processing and signed response delivery."""

from __future__ import annotations

import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from threading import Event
from typing import Any, Protocol

from agent.config import PriceAlert
from agent.http import RemoteError
from agent.identity import HostIdentity, clean_message
from agent.state import AgentState, OutboxJob, ScheduledJob

LOG = logging.getLogger("signal_id_agent")


class TickerSource(Protocol):
    def ticker(self, symbol: str) -> dict[str, Any]: ...


class RoomClient(Protocol):
    def read_room(self, room: str, since: int, wait: int) -> dict[str, Any]: ...

    def post_signed(self, room: str, signed: dict[str, str]) -> dict[str, Any]: ...


def _is_nonce_replay(error: RemoteError) -> bool:
    message = str(error).casefold()
    return (
        error.status == 400
        and "nonce " in message
        and ("not greater than" in message or "single-use" in message)
    )


@dataclass(frozen=True, slots=True)
class Ticker:
    symbol: str
    price: Decimal
    change: Decimal
    high: Decimal
    low: Decimal

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> Ticker:
        try:
            return cls(
                symbol=str(value["symbol"]),
                price=Decimal(str(value["lastPrice"])),
                change=Decimal(str(value["priceChangePercent"])),
                high=Decimal(str(value["highPrice"])),
                low=Decimal(str(value["lowPrice"])),
            )
        except (KeyError, InvalidOperation) as exc:
            raise RemoteError("Binance returned an invalid ticker") from exc


def _asset(symbol: str) -> str:
    return symbol.removesuffix("USDT")


def _price(value: Decimal) -> str:
    if value >= 1000:
        return f"${value:,.2f}"
    if value >= 1:
        return f"${value:,.4f}"
    return f"${value:,.8f}"


def _change(value: Decimal) -> str:
    return f"{value:+.2f}%"


@dataclass(slots=True)
class CommandResponder:
    binance: TickerSource
    watchlist: tuple[str, ...]

    def _mentioned(self, text: str) -> list[str]:
        words = set(re.findall(r"[A-Z0-9]{2,16}", text.upper()))
        return [symbol for symbol in self.watchlist if symbol in words or _asset(symbol) in words]

    def _ticker(self, symbol: str) -> Ticker:
        return Ticker.from_json(self.binance.ticker(symbol))

    def _help(self) -> str:
        assets = ", ".join(_asset(symbol) for symbol in self.watchlist)
        return (
            "Commands: 'BTC price', 'compare BTC ETH', 'BTC range', 'top gainers', "
            f"or 'top losers'. Configured assets: {assets}."
        )

    def report(self) -> str:
        tickers = [self._ticker(symbol) for symbol in self.watchlist]
        leader = max(tickers, key=lambda ticker: ticker.change)
        values = " · ".join(
            f"{_asset(ticker.symbol)} {_price(ticker.price)} ({_change(ticker.change)})"
            for ticker in tickers
        )
        return (
            f"Scheduled market report · {values}. 24h leader: {_asset(leader.symbol)}. "
            "Source: Binance Spot."
        )

    def alert(self, rule: PriceAlert, ticker: Ticker) -> str:
        direction = "at or above" if rule.operator == ">=" else "at or below"
        return (
            f"Price alert · {_asset(rule.symbol)} is {_price(ticker.price)}, {direction} "
            f"{_price(rule.threshold)}. 24h {_change(ticker.change)}. Source: Binance Spot."
        )

    def answer(self, command: str) -> str:
        text = clean_message(command)
        lowered = text.casefold()
        mentioned = self._mentioned(text)
        if "help" in lowered or lowered in {"?", "commands"}:
            return self._help()
        if "gainer" in lowered or "loser" in lowered:
            tickers = sorted(
                (self._ticker(symbol) for symbol in self.watchlist),
                key=lambda ticker: ticker.change,
                reverse="gainer" in lowered,
            )
            direction = "Gainers" if "gainer" in lowered else "Losers"
            values = " · ".join(
                f"{_asset(ticker.symbol)} {_change(ticker.change)}" for ticker in tickers[:5]
            )
            return f"{direction} on the configured watchlist: {values}. Source: Binance Spot."
        if "compare" in lowered:
            if len(mentioned) < 2:
                return "Compare needs at least two configured assets. " + self._help()
            tickers = [self._ticker(symbol) for symbol in mentioned]
            values = " · ".join(
                f"{_asset(ticker.symbol)} {_price(ticker.price)} ({_change(ticker.change)})"
                for ticker in tickers
            )
            best = max(tickers, key=lambda ticker: ticker.change)
            return f"{values}. Best 24h performance: {_asset(best.symbol)}. Source: Binance Spot."
        if "range" in lowered:
            if not mentioned:
                return "Range needs one configured asset. " + self._help()
            ticker = self._ticker(mentioned[0])
            return (
                f"{_asset(ticker.symbol)} 24h range: {_price(ticker.low)}–{_price(ticker.high)}; "
                f"last {_price(ticker.price)} ({_change(ticker.change)}). Source: Binance Spot."
            )
        if mentioned and ("price" in lowered or len(lowered.split()) <= 2):
            ticker = self._ticker(mentioned[0])
            return (
                f"{_asset(ticker.symbol)}: {_price(ticker.price)} · "
                f"24h {_change(ticker.change)}. Source: Binance Spot."
            )
        return self._help()


@dataclass(slots=True)
class AgentService:
    room: str
    allowed_dids: frozenset[str]
    identity: HostIdentity
    state: AgentState
    technocore: RoomClient
    responder: CommandResponder
    report_interval: int = 0
    price_alerts: tuple[PriceAlert, ...] = ()
    alert_check_interval: int = 60
    alert_cooldown: int = 3600
    clock: Callable[[], float] = time.time
    _last_alert_check: float = 0.0

    def _deliver(self, job: OutboxJob) -> None:
        signed = self.identity.signed_message(job.room, job.nonce, job.text)
        try:
            self.technocore.post_signed(job.room, signed)
        except RemoteError as exc:
            # A retry with the exact durable nonce receives Technocore's specific 400 replay
            # refusal when the first POST landed but its response was lost. No other process
            # should use this Host seed/room pair.
            if not _is_nonce_replay(exc):
                raise
        self.state.mark_delivered(job.room, job.request_seq)
        LOG.info("delivered signed reply request_seq=%s nonce=%s", job.request_seq, job.nonce)

    def _deliver_scheduled(self, job: ScheduledJob) -> None:
        signed = self.identity.signed_message(job.room, job.nonce, job.text)
        try:
            self.technocore.post_signed(job.room, signed)
        except RemoteError as exc:
            if not _is_nonce_replay(exc):
                raise
        self.state.mark_scheduled_delivered(job.room, job.job_key)
        LOG.info("delivered signed scheduled job=%s nonce=%s", job.job_key, job.nonce)

    def retry_pending(self) -> int:
        jobs = self.state.pending_jobs(self.room)
        for job in jobs:
            self._deliver(job)
        scheduled = self.state.pending_scheduled_jobs(self.room)
        for job in scheduled:
            self._deliver_scheduled(job)
        return len(jobs) + len(scheduled)

    def run_scheduled(self) -> int:
        now = int(self.clock())
        delivered = 0
        if self.report_interval:
            job_key = f"report:{now // self.report_interval}"
            job = self.state.get_scheduled_job(self.room, job_key)
            if job is None:
                job = self.state.prepare_scheduled_job(
                    self.room, job_key, clean_message(self.responder.report())
                )
            if not job.delivered:
                self._deliver_scheduled(job)
                delivered += 1

        if self.price_alerts and now - self._last_alert_check >= self.alert_check_interval:
            self._last_alert_check = now
            tickers: dict[str, Ticker] = {}
            for rule in self.price_alerts:
                if rule.symbol not in tickers:
                    tickers[rule.symbol] = self.responder._ticker(rule.symbol)
                ticker = tickers[rule.symbol]
                crossed = (
                    ticker.price >= rule.threshold
                    if rule.operator == ">="
                    else (ticker.price <= rule.threshold)
                )
                if not crossed:
                    continue
                slot = now // self.alert_cooldown
                job_key = f"alert:{rule.key}:{slot}"
                job = self.state.get_scheduled_job(self.room, job_key)
                if job is None:
                    job = self.state.prepare_scheduled_job(
                        self.room,
                        job_key,
                        clean_message(self.responder.alert(rule, ticker)),
                    )
                if not job.delivered:
                    self._deliver_scheduled(job)
                    delivered += 1
        return delivered

    @staticmethod
    def _sequence(message: dict[str, Any]) -> int | None:
        try:
            sequence = int(message.get("seq", 0))
        except (TypeError, ValueError):
            return None
        return sequence if sequence > 0 else None

    def _handle(self, message: dict[str, Any]) -> bool:
        sequence = self._sequence(message)
        if sequence is None:
            return False
        sender = str(message.get("from", ""))
        if sender == self.identity.did or sender not in self.allowed_dids:
            self.state.advance_cursor(self.room, sequence)
            return False

        existing = self.state.get_job(self.room, sequence)
        if existing is None:
            answer = self.responder.answer(str(message.get("text", "")))
            reply = clean_message(f"Re #{sequence} · {answer}")
            existing = self.state.prepare_job(self.room, sequence, sender, reply)
        if not existing.delivered:
            self._deliver(existing)
        self.state.advance_cursor(self.room, sequence)
        return True

    def poll_once(self, wait: int) -> int:
        self.retry_pending()
        cursor = self.state.cursor(self.room)
        view = self.technocore.read_room(self.room, cursor, wait)
        messages = view.get("messages", [])
        if not isinstance(messages, list):
            raise RemoteError("Technocore room response has no messages array")
        handled = 0
        for message in sorted(
            (value for value in messages if isinstance(value, dict)),
            key=lambda value: self._sequence(value) or 0,
        ):
            sequence = self._sequence(message)
            if sequence is None or sequence <= self.state.cursor(self.room):
                continue
            handled += int(self._handle(message))
        return handled

    def run_forever(self, stop: Event, poll_wait: int) -> None:
        backoff = 1.0
        while not stop.is_set():
            try:
                self.poll_once(poll_wait)
                self.run_scheduled()
                backoff = 1.0
            except RemoteError as exc:
                delay = exc.retry_after if exc.retry_after is not None else backoff
                LOG.warning("remote request failed; retrying in %.1fs: %s", delay, exc)
                stop.wait(delay)
                backoff = min(backoff * 2, 60.0)
            except Exception:
                LOG.exception("agent iteration failed; retrying in %.1fs", backoff)
                stop.wait(backoff)
                backoff = min(backoff * 2, 60.0)
            time.sleep(0)
