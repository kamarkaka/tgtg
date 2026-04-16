# TGTG Monitor

A self-hosted web app that monitors [Too Good To Go](https://www.toogoodtogo.com) surprise bag availability and sends push notifications via [Gotify](https://gotify.net) when bags become available.

## Features

- Polls TGTG API every minute for each monitored item
- Sends Gotify notifications with bag details (price, pickup time, address, reserve link)
- Daily notification cap (10 per item) to avoid spam
- Simple web UI to add/remove monitored items
- Single-user session-based authentication
- Puppeteer with stealth plugin to bypass bot detection

## Quick Start

### Local

```bash
cp .env.example .env  # edit with your credentials
npm install
npm start
# Open http://localhost:3000
```

### Docker

```bash
docker build -t tgtg-monitor .

docker run -d \
  -p 3000:3000 \
  -v /path/to/.env:/app/.env \
  -v /path/to/data:/data \
  tgtg-monitor
```

The SQLite database is stored at `/data/tgtg.db` inside the container. Mount `/data` to persist it.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `USERNAME` | No | `admin` | Login username |
| `PASSWORD` | No | `changeme` | Login password |
| `SESSION_SECRET` | No | `change-me-in-production` | Express session secret |
| `GOTIFY_URL` | Yes | | Gotify server URL (e.g. `https://gotify.example.com`) |
| `GOTIFY_TOKEN` | Yes | | Gotify app token |
| `CHECK_INTERVAL_MS` | No | `60000` | Polling interval in milliseconds |
| `NOTIFICATION_RETENTION_DAYS` | No | `7` | Days to keep notification history |
| `DB_PATH` | No | `./tgtg.db` | SQLite database file path |

## How It Works

1. The server polls `https://www.toogoodtogo.com/api/surprise-bags/bag/{itemId}` for each monitored item
2. If `itemsAvailable > 0`, it sends a Gotify notification with:
   - Store name and bag count
   - Price (e.g. `$3.99`)
   - Pickup window (e.g. `4:30 PM - 5:00 PM`)
   - Address
   - Direct link to reserve
3. Notifications are capped at 10 per item per day

## License

See [LICENSE](LICENSE).
