# Signal ID Host Agent

This is the outbound-only VPS half of the demo dApp. It long-polls one unlisted Technocore
mailbox, accepts commands only from an explicit allowlist of signed User DIDs, fetches public
Binance Spot prices, and posts every reply under a separate Host DID.

The VPS needs internet egress but no inbound port, reverse proxy, TLS certificate, or domain.
Technocore remains the transport and Vercel remains the browser origin.

## Trust and persistence

- `HOST_SEED_FILE` exists only on the VPS. Replies still carry its verified DID in Technocore JSON,
  but the client does not configure or specially label a Host identity.
- `MAILBOX_ROOM` must begin `mb-p-`: `mb-` refuses unsigned writes and `p-` keeps the room out
  of public room listings. The random room suffix is still a bearer secret, not encryption.
- `ALLOWED_USER_DIDS` prevents any other signed DID that learns the room name from invoking the
  price agent.
- SQLite stores the last room cursor, per-room Host nonce, and a durable outbox. A retry uses the
  same signature and nonce; Technocore's exact nonce-replay refusal therefore closes the “POST
  landed but its HTTP response was lost” crash window without emitting another answer.
- Reports and alerts are disabled by default. When enabled, they use the same durable signed
  outbox as interactive responses.

## Provision the VPS

These commands assume the repository is in `/opt/technocore-chat` and `uv` is installed:

```bash
cd /opt/technocore-chat
uv sync --frozen

sudo useradd --system --home /var/lib/signal-id-agent --shell /usr/sbin/nologin signal-id
sudo install -d -o signal-id -g signal-id -m 0700 /var/lib/signal-id-agent
sudo -u signal-id .venv/bin/python -m agent keygen \
  --output /var/lib/signal-id-agent/host.seed
```

The key generator prints the public `HOST_DID` but writes the seed only to the mode-0600 file.
Generate the mailbox name separately and keep it out of public logs:

```bash
openssl rand -hex 16
```

Prefix that output with `mb-p-`. Copy `.env.example` to `/etc/signal-id-agent.env`, replace the
mailbox and User DID placeholders, then restrict it:

```bash
sudo install -o root -g signal-id -m 0640 agent/.env.example /etc/signal-id-agent.env
sudo editor /etc/signal-id-agent.env
```

Test one non-blocking poll before enabling the service:

```bash
sudo -u signal-id sh -c \
  'set -a; . /etc/signal-id-agent.env; set +a; exec /opt/technocore-chat/.venv/bin/python -m agent once'
```

Install `deploy/signal-id-agent.service`, then start it:

```bash
sudo install -m 0644 deploy/signal-id-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now signal-id-agent
sudo systemctl status signal-id-agent
sudo journalctl -u signal-id-agent -f
```

The printed public DID is useful for logs and manual verification. Nothing from `HOST_SEED_FILE`
or the Host seed belongs in Vercel.

## Commands and schedules

The Host understands `BTC price`, `compare BTC ETH`, `BTC range`, `top gainers`, `top losers`,
and `help`. Assets are restricted to `WATCHLIST`, which bounds Binance traffic even if an allowed
User DID sends arbitrary text.

Set `REPORT_INTERVAL_MINUTES=15` for a report every 15 minutes. Configure threshold alerts like:

```dotenv
PRICE_ALERTS=BTCUSDT>=100000,ETHUSDT<=3000
ALERT_CHECK_SECONDS=60
ALERT_COOLDOWN_MINUTES=60
```

An alert is emitted at most once per cooldown slot while its condition remains true. All price
answers state that Binance Spot is their source; they are informational demo data, not trading
instructions.

## Local-only HTTP test

Plain HTTP is refused by default. For a local Technocore instance only, set
`ALLOW_INSECURE_HTTP=1` together with a loopback `TECHNOCORE_URL`. Never enable this on the VPS.
