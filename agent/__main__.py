"""CLI entry point for provisioning and running the Host Agent."""

from __future__ import annotations

import argparse
import logging
import os
import secrets
import signal
from pathlib import Path
from threading import Event

from agent.config import AgentConfig
from agent.http import BinanceClient, JsonHttpClient, TechnocoreClient
from agent.identity import HostIdentity
from agent.service import AgentService, CommandResponder
from agent.state import AgentState


def _write_seed(path: Path) -> HostIdentity:
    if path.exists():
        raise SystemExit(f"refusing to overwrite existing seed file: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    seed = secrets.token_hex(32)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="ascii") as handle:
            handle.write(seed + "\n")
    except OSError as exc:
        raise SystemExit(f"cannot create seed file {path}: {exc}") from exc
    return HostIdentity.from_seed_hex(seed)


def _service(config: AgentConfig, state: AgentState) -> AgentService:
    identity = HostIdentity.from_file(config.host_seed_file)
    technocore = TechnocoreClient(JsonHttpClient(config.technocore_url, config.request_timeout))
    binance = BinanceClient(JsonHttpClient(config.binance_url, config.request_timeout))
    return AgentService(
        room=config.mailbox_room,
        allowed_dids=config.allowed_dids,
        identity=identity,
        state=state,
        technocore=technocore,
        responder=CommandResponder(binance, config.watchlist),
        report_interval=config.report_interval,
        price_alerts=config.price_alerts,
        alert_check_interval=config.alert_check_interval,
        alert_cooldown=config.alert_cooldown,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Signal ID outbound Technocore Host Agent")
    subparsers = parser.add_subparsers(dest="command", required=True)
    keygen = subparsers.add_parser("keygen", help="create a mode-0600 Host seed file")
    keygen.add_argument("--output", type=Path, required=True)
    show_did = subparsers.add_parser("did", help="print the DID for an existing seed file")
    show_did.add_argument("--seed-file", type=Path, required=True)
    subparsers.add_parser("once", help="process one mailbox poll and exit")
    subparsers.add_parser("run", help="run the long-poll service")
    args = parser.parse_args()

    if args.command == "keygen":
        identity = _write_seed(args.output)
        print(f"Host seed written to {args.output}")
        print(f"HOST_DID={identity.did}")
        return
    if args.command == "did":
        print(HostIdentity.from_file(args.seed_file).did)
        return

    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    try:
        config = AgentConfig.from_env()
        identity = HostIdentity.from_file(config.host_seed_file)
    except ValueError as exc:
        raise SystemExit(f"configuration error: {exc}") from exc
    logging.getLogger("signal_id_agent").info(
        "starting host_did=%s mailbox=%s allowed_users=%s",
        identity.did,
        config.mailbox_room,
        len(config.allowed_dids),
    )
    with AgentState(config.state_path) as state:
        service = _service(config, state)
        if args.command == "once":
            service.poll_once(0)
            service.run_scheduled()
            return
        stop = Event()
        for signal_name in (signal.SIGINT, signal.SIGTERM):
            signal.signal(signal_name, lambda *_: stop.set())
        service.run_forever(stop, config.poll_wait)


if __name__ == "__main__":
    main()
