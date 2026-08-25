from __future__ import annotations

import base64
import json
from decimal import Decimal
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from agent.config import AgentConfig, PriceAlert
from agent.http import JsonHttpClient, RemoteError, TechnocoreClient
from agent.identity import HostIdentity, clean_message
from agent.service import AgentService, CommandResponder
from agent.state import AgentState

HOST_SEED = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
USER_SEED = "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f"


class FakeResponse:
    def __init__(self, value: dict) -> None:
        self.raw = json.dumps(value).encode()

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_: object) -> None:
        pass

    def read(self, _: int) -> bytes:
        return self.raw


class FakeBinance:
    VALUES = {
        "BTCUSDT": {
            "symbol": "BTCUSDT",
            "lastPrice": "100000.50",
            "priceChangePercent": "2.50",
            "highPrice": "101000",
            "lowPrice": "97000",
        },
        "ETHUSDT": {
            "symbol": "ETHUSDT",
            "lastPrice": "4000",
            "priceChangePercent": "-1.25",
            "highPrice": "4100",
            "lowPrice": "3900",
        },
    }

    def ticker(self, symbol: str) -> dict:
        return self.VALUES[symbol]


class FakeTechnocore:
    def __init__(self, messages: list[dict]) -> None:
        self.messages = messages
        self.posts: list[tuple[str, dict[str, str]]] = []
        self.post_error: RemoteError | None = None

    def read_room(self, room: str, since: int, wait: int) -> dict:
        assert room == "mb-p-testsecret"
        assert 0 <= wait <= 10
        return {"messages": [message for message in self.messages if message["seq"] > since]}

    def post_signed(self, room: str, signed: dict[str, str]) -> dict:
        self.posts.append((room, signed))
        if self.post_error:
            raise self.post_error
        return {"posted": {"seq": 99, "from": signed["did"], **signed}}


def test_config_requires_private_mailbox_allowlist_and_https(tmp_path: Path) -> None:
    user = HostIdentity.from_seed_hex(USER_SEED)
    config = AgentConfig.from_env(
        {
            "MAILBOX_ROOM": "mb-p-testsecret",
            "ALLOWED_USER_DIDS": user.did,
            "HOST_SEED_FILE": str(tmp_path / "host.seed"),
            "AGENT_STATE_PATH": str(tmp_path / "state.sqlite3"),
            "WATCHLIST": "BTCUSDT,ETHUSDT,BTCUSDT",
            "REPORT_INTERVAL_MINUTES": "5",
            "PRICE_ALERTS": "BTCUSDT>=100000,ETHUSDT<=3000",
        }
    )
    assert config.mailbox_room == "mb-p-testsecret"
    assert config.allowed_dids == {user.did}
    assert config.watchlist == ("BTCUSDT", "ETHUSDT")
    assert config.report_interval == 300
    assert config.price_alerts[0].threshold == Decimal("100000")
    with pytest.raises(ValueError, match="private signed mailbox"):
        AgentConfig.from_env({"MAILBOX_ROOM": "public", "ALLOWED_USER_DIDS": user.did})
    with pytest.raises(ValueError, match="one or more valid"):
        AgentConfig.from_env({"MAILBOX_ROOM": "mb-p-testsecret"})
    with pytest.raises(ValueError, match="HTTPS origin"):
        AgentConfig.from_env(
            {
                "MAILBOX_ROOM": "mb-p-testsecret",
                "ALLOWED_USER_DIDS": user.did,
                "TECHNOCORE_URL": "http://chat.example",
            }
        )
    local = AgentConfig.from_env(
        {
            "MAILBOX_ROOM": "mb-p-testsecret",
            "ALLOWED_USER_DIDS": user.did,
            "TECHNOCORE_URL": "http://127.0.0.1:8080/",
            "BINANCE_URL": "http://localhost:8090",
            "ALLOW_INSECURE_HTTP": "1",
        }
    )
    assert local.technocore_url == "http://127.0.0.1:8080"
    with pytest.raises(ValueError, match="loopback HTTP"):
        AgentConfig.from_env(
            {
                "MAILBOX_ROOM": "mb-p-testsecret",
                "ALLOWED_USER_DIDS": user.did,
                "TECHNOCORE_URL": "http://chat.example",
                "ALLOW_INSECURE_HTTP": "1",
            }
        )


def test_host_identity_signs_exact_swept_canonical() -> None:
    identity = HostIdentity.from_seed_hex(HOST_SEED)
    signed = identity.signed_message("mb-p-testsecret", 123, " hello\nworld\u200b ")
    assert signed["text"] == "hello world"
    assert signed["nonce"] == "123"
    signature = base64.urlsafe_b64decode(signed["sig"] + "==")
    identity.key.public_key().verify(signature, b"mb-p-testsecret|123|hello world")
    assert clean_message(" x\ty ") == "x y"
    with pytest.raises(ValueError, match="64 hexadecimal"):
        HostIdentity.from_seed_hex("bad")


def test_host_identity_loads_a_private_regular_seed_file(tmp_path: Path) -> None:
    seed_file = tmp_path / "host.seed"
    seed_file.write_text(HOST_SEED + "\n", encoding="ascii")
    seed_file.chmod(0o600)
    assert HostIdentity.from_file(seed_file).did == HostIdentity.from_seed_hex(HOST_SEED).did


def test_fixed_origin_http_clients_build_contract_requests() -> None:
    requests = []

    def opener(request, timeout):
        requests.append((request, timeout))
        if request.method == "POST":
            return FakeResponse({"posted": {"seq": 7}})
        return FakeResponse({"messages": []})

    client = TechnocoreClient(JsonHttpClient("https://chat.example", 20, opener))
    assert client.read_room("mb-p-testsecret", 4, 10) == {"messages": []}
    read_url = urlsplit(requests[0][0].full_url)
    assert read_url.path == "/r/mb-p-testsecret"
    assert parse_qs(read_url.query) == {
        "format": ["json"],
        "since": ["4"],
        "limit": ["200"],
        "wait": ["10"],
    }
    signed = {"did": "did:key:test", "sig": "signature", "nonce": "1", "text": "hello"}
    assert client.post_signed("mb-p-testsecret", signed)["posted"]["seq"] == 7
    assert json.loads(requests[1][0].data) == signed
    assert requests[1][0].method == "POST"


def test_responder_uses_configured_watchlist_only() -> None:
    responder = CommandResponder(FakeBinance(), ("BTCUSDT", "ETHUSDT"))
    assert "BTC: $100,000.50" in responder.answer("BTC price")
    assert "Best 24h performance: BTC" in responder.answer("compare BTC and ETH")
    assert "ETH -1.25%" in responder.answer("top losers")
    assert "ETH 24h range: $3,900.00–$4,100.00" in responder.answer("ETH range")
    assert "Configured assets: BTC, ETH" in responder.answer("DOGE price")


def test_service_filters_dids_and_persists_delivery(tmp_path: Path) -> None:
    host = HostIdentity.from_seed_hex(HOST_SEED)
    user = HostIdentity.from_seed_hex(USER_SEED)
    remote = FakeTechnocore(
        [
            {"seq": 1, "from": "unsigned-nick", "text": "BTC price"},
            {"seq": 2, "from": user.did, "text": "BTC price"},
        ]
    )
    state_path = tmp_path / "agent.sqlite3"
    with AgentState(state_path) as state:
        service = AgentService(
            "mb-p-testsecret",
            frozenset({user.did}),
            host,
            state,
            remote,
            CommandResponder(FakeBinance(), ("BTCUSDT", "ETHUSDT")),
        )
        assert service.poll_once(0) == 1
        assert state.cursor("mb-p-testsecret") == 2
        assert len(remote.posts) == 1
        signed = remote.posts[0][1]
        assert signed["did"] == host.did
        assert signed["text"].startswith("Re #2 · BTC:")
        assert service.poll_once(0) == 0
        assert len(remote.posts) == 1

    with AgentState(state_path) as reopened:
        job = reopened.get_job("mb-p-testsecret", 2)
        assert job is not None and job.delivered
        assert reopened.cursor("mb-p-testsecret") == 2


def test_pending_outbox_treats_exact_nonce_replay_as_delivered(tmp_path: Path) -> None:
    host = HostIdentity.from_seed_hex(HOST_SEED)
    user = HostIdentity.from_seed_hex(USER_SEED)
    remote = FakeTechnocore([])
    remote.post_error = RemoteError(
        "400 nonce 123 is not greater than 123, the last one this key used", status=400
    )
    with AgentState(tmp_path / "state.sqlite3") as state:
        pending = state.prepare_job("mb-p-testsecret", 8, user.did, "Re #8 · recovered")
        service = AgentService(
            "mb-p-testsecret",
            frozenset({user.did}),
            host,
            state,
            remote,
            CommandResponder(FakeBinance(), ("BTCUSDT", "ETHUSDT")),
        )
        assert service.retry_pending() == 1
        delivered = state.get_job(pending.room, pending.request_seq)
        assert delivered is not None and delivered.delivered


def test_outbox_does_not_swallow_an_unrelated_bad_request(tmp_path: Path) -> None:
    host = HostIdentity.from_seed_hex(HOST_SEED)
    user = HostIdentity.from_seed_hex(USER_SEED)
    remote = FakeTechnocore([])
    remote.post_error = RemoteError("400 malformed payload", status=400)
    with AgentState(tmp_path / "state.sqlite3") as state:
        state.prepare_job("mb-p-testsecret", 8, user.did, "Re #8 · recovered")
        service = AgentService(
            "mb-p-testsecret",
            frozenset({user.did}),
            host,
            state,
            remote,
            CommandResponder(FakeBinance(), ("BTCUSDT", "ETHUSDT")),
        )
        with pytest.raises(RemoteError, match="malformed payload"):
            service.retry_pending()


def test_scheduler_posts_one_report_and_crossed_alert_per_slot(tmp_path: Path) -> None:
    host = HostIdentity.from_seed_hex(HOST_SEED)
    remote = FakeTechnocore([])
    now = [3_600.0]
    with AgentState(tmp_path / "state.sqlite3") as state:
        service = AgentService(
            "mb-p-testsecret",
            frozenset(),
            host,
            state,
            remote,
            CommandResponder(FakeBinance(), ("BTCUSDT", "ETHUSDT")),
            report_interval=300,
            price_alerts=(
                PriceAlert("BTCUSDT", ">=", Decimal("100000")),
                PriceAlert("ETHUSDT", "<=", Decimal("3000")),
            ),
            alert_check_interval=60,
            alert_cooldown=3600,
            clock=lambda: now[0],
        )
        assert service.run_scheduled() == 2
        assert len(remote.posts) == 2
        assert remote.posts[0][1]["text"].startswith("Scheduled market report")
        assert remote.posts[1][1]["text"].startswith("Price alert · BTC")
        assert service.run_scheduled() == 0
        assert len(remote.posts) == 2
        now[0] += 300
        assert service.run_scheduled() == 1
        assert len(remote.posts) == 3
