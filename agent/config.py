"""Environment configuration for the VPS Host Agent."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlsplit

DID_RE = re.compile(r"did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}")
ROOM_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,47}")
SYMBOL_RE = re.compile(r"[A-Z0-9]{2,16}")
ALERT_RE = re.compile(r"([A-Z0-9]{2,16})(>=|<=)([0-9]+(?:\.[0-9]+)?)")


def _origin(value: str, name: str, *, allow_http: bool = False) -> str:
    raw = value.strip().rstrip("/")
    parsed = urlsplit(raw)
    local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    secure = parsed.scheme == "https"
    local_test = allow_http and local and parsed.scheme == "http"
    if (
        not (secure or local_test)
        or not parsed.netloc
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
        or parsed.username
        or parsed.password
    ):
        raise ValueError(f"{name} must be an HTTPS origin (or loopback HTTP in local tests)")
    return f"{parsed.scheme}://{parsed.netloc}"


def _positive_int(value: str, name: str, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if not minimum <= parsed <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return parsed


@dataclass(frozen=True, slots=True)
class PriceAlert:
    symbol: str
    operator: str
    threshold: Decimal

    @property
    def key(self) -> str:
        return f"{self.symbol}{self.operator}{self.threshold}"


def _price_alerts(value: str, watchlist: tuple[str, ...]) -> tuple[PriceAlert, ...]:
    alerts: list[PriceAlert] = []
    for raw in (item.strip().upper() for item in value.split(",")):
        if not raw:
            continue
        match = ALERT_RE.fullmatch(raw)
        if not match or match[1] not in watchlist:
            raise ValueError("PRICE_ALERTS must use configured symbols, e.g. BTCUSDT>=100000")
        try:
            threshold = Decimal(match[3])
        except InvalidOperation as exc:
            raise ValueError("PRICE_ALERTS contains an invalid threshold") from exc
        if threshold <= 0:
            raise ValueError("PRICE_ALERTS thresholds must be greater than zero")
        alerts.append(PriceAlert(match[1], match[2], threshold))
    if len(alerts) > 20:
        raise ValueError("PRICE_ALERTS supports at most 20 rules")
    return tuple(alerts)


@dataclass(frozen=True, slots=True)
class AgentConfig:
    technocore_url: str
    mailbox_room: str
    host_seed_file: Path
    allowed_dids: frozenset[str]
    state_path: Path
    watchlist: tuple[str, ...]
    poll_wait: int = 10
    request_timeout: int = 20
    binance_url: str = "https://api.binance.com"
    report_interval: int = 0
    price_alerts: tuple[PriceAlert, ...] = ()
    alert_check_interval: int = 60
    alert_cooldown: int = 3600

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> AgentConfig:
        values = os.environ if environ is None else environ
        allow_http = values.get("ALLOW_INSECURE_HTTP") == "1"
        room = values.get("MAILBOX_ROOM", "").strip().lower()
        if not ROOM_RE.fullmatch(room) or not room.startswith("mb-p-"):
            raise ValueError("MAILBOX_ROOM must be a private signed mailbox named mb-p-<secret>")

        allowed = frozenset(
            item.strip() for item in values.get("ALLOWED_USER_DIDS", "").split(",") if item.strip()
        )
        if not allowed or any(not DID_RE.fullmatch(did) for did in allowed):
            raise ValueError("ALLOWED_USER_DIDS must contain one or more valid did:key values")

        raw_watchlist = values.get("WATCHLIST", "BTCUSDT,ETHUSDT,SOLUSDT")
        watchlist = tuple(dict.fromkeys(item.strip().upper() for item in raw_watchlist.split(",")))
        if (
            not watchlist
            or len(watchlist) > 20
            or any(
                not SYMBOL_RE.fullmatch(symbol) or not symbol.endswith("USDT")
                for symbol in watchlist
            )
        ):
            raise ValueError("WATCHLIST must contain 1-20 comma-separated USDT symbols")

        report_minutes = _positive_int(
            values.get("REPORT_INTERVAL_MINUTES", "0"),
            "REPORT_INTERVAL_MINUTES",
            0,
            1440,
        )
        return cls(
            technocore_url=_origin(
                values.get("TECHNOCORE_URL", "https://technocore.chat"),
                "TECHNOCORE_URL",
                allow_http=allow_http,
            ),
            mailbox_room=room,
            host_seed_file=Path(values.get("HOST_SEED_FILE", "data/host.seed")),
            allowed_dids=allowed,
            state_path=Path(values.get("AGENT_STATE_PATH", "data/agent.sqlite3")),
            watchlist=watchlist,
            poll_wait=_positive_int(values.get("POLL_WAIT", "10"), "POLL_WAIT", 0, 10),
            request_timeout=_positive_int(
                values.get("REQUEST_TIMEOUT", "20"), "REQUEST_TIMEOUT", 5, 120
            ),
            binance_url=_origin(
                values.get("BINANCE_URL", "https://api.binance.com"),
                "BINANCE_URL",
                allow_http=allow_http,
            ),
            report_interval=report_minutes * 60,
            price_alerts=_price_alerts(values.get("PRICE_ALERTS", ""), watchlist),
            alert_check_interval=_positive_int(
                values.get("ALERT_CHECK_SECONDS", "60"), "ALERT_CHECK_SECONDS", 15, 3600
            ),
            alert_cooldown=_positive_int(
                values.get("ALERT_COOLDOWN_MINUTES", "60"),
                "ALERT_COOLDOWN_MINUTES",
                1,
                10080,
            )
            * 60,
        )
