"""Small fixed-origin HTTP clients for Technocore and Binance."""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

MAX_RESPONSE_BYTES = 2_000_000


class RemoteError(RuntimeError):
    def __init__(self, message: str, status: int = 0, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


def _retry_after(value: str | None) -> float | None:
    try:
        return max(0.0, float(value)) if value is not None else None
    except ValueError:
        return None


@dataclass(slots=True)
class JsonHttpClient:
    origin: str
    timeout: int
    opener: Callable[..., Any] = urlopen

    def request(
        self,
        method: str,
        path: str,
        *,
        query: dict[str, str | int] | None = None,
        payload: dict[str, str] | None = None,
        timeout: int | None = None,
    ) -> dict[str, Any]:
        url = self.origin + path
        if query:
            url += "?" + urlencode(query)
        body = json.dumps(payload, separators=(",", ":")).encode() if payload is not None else None
        request = Request(
            url,
            data=body,
            method=method,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "signal-id-host-agent/1",
            },
        )
        try:
            with self.opener(request, timeout=timeout or self.timeout) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as exc:
            detail = exc.read(4096).decode("utf-8", "replace").splitlines()[0:1]
            message = detail[0] if detail else str(exc.reason)
            raise RemoteError(
                f"HTTP {exc.code}: {message}",
                exc.code,
                _retry_after(exc.headers.get("Retry-After")),
            ) from exc
        except URLError as exc:
            raise RemoteError(f"Network error: {exc.reason}") from exc
        if len(raw) > MAX_RESPONSE_BYTES:
            raise RemoteError("Remote JSON response exceeded the 2 MB safety limit")
        try:
            value = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RemoteError("Remote server returned invalid JSON") from exc
        if not isinstance(value, dict):
            raise RemoteError("Remote server returned a non-object JSON response")
        return value


@dataclass(slots=True)
class TechnocoreClient:
    http: JsonHttpClient

    def read_room(self, room: str, since: int, wait: int) -> dict[str, Any]:
        return self.http.request(
            "GET",
            f"/r/{quote(room, safe='')}",
            query={"format": "json", "since": since, "limit": 200, "wait": wait},
            timeout=self.http.timeout + wait,
        )

    def post_signed(self, room: str, signed: dict[str, str]) -> dict[str, Any]:
        return self.http.request(
            "POST", f"/r/{quote(room, safe='')}", query={"format": "json"}, payload=signed
        )


@dataclass(slots=True)
class BinanceClient:
    http: JsonHttpClient

    def ticker(self, symbol: str) -> dict[str, Any]:
        return self.http.request("GET", "/api/v3/ticker/24hr", query={"symbol": symbol})
