# TGTG Monitor - Web App Plan

## Overview

A single-user web app that monitors Too Good To Go surprise bag availability and sends Gotify notifications when items become available.

## Tech Stack

- **Backend**: Node.js + Express
- **Frontend**: Vanilla HTML/CSS/JS (minimal)
- **Database**: SQLite (`tgtg.db`, created fresh on first run)
- **Auth**: Simple username/password via environment variables, session-based
- **Notifications**: Gotify REST API

## Environment Variables

```
USERNAME=admin
PASSWORD=changeme
SESSION_SECRET=random-secret
GOTIFY_URL=https://gotify.example.com
GOTIFY_TOKEN=your-app-token
CHECK_INTERVAL_MS=60000        # optional, default 60s
NOTIFICATION_RETENTION_DAYS=7  # optional, default 7
```

## Database Schema

Created fresh on first run. Two tables:

```sql
-- Items to monitor
CREATE TABLE items (
  itemId TEXT PRIMARY KEY,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Track daily notification count per item (max 10/day)
CREATE TABLE notifications (
  itemId TEXT NOT NULL,
  date TEXT NOT NULL,           -- YYYY-MM-DD
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (itemId, date),
  FOREIGN KEY (itemId) REFERENCES items(itemId) ON DELETE CASCADE
);
```

- `itemId` is TEXT since the existing data includes large IDs (e.g. `72185609530611713`) that exceed JS safe integer range
- `notifications` rows are cleaned up automatically when an item is deleted (CASCADE)

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/login` | No | Login with username/password |
| POST | `/api/logout` | Yes | Logout |
| GET | `/api/session` | No | Check if logged in |
| GET | `/api/items` | Yes | List all monitored itemIds |
| POST | `/api/items` | Yes | Add an itemId `{ itemId }` |
| DELETE | `/api/items/:itemId` | Yes | Remove an itemId |

## Backend Logic

### Polling Loop (every 60s)

```
for each itemId in items table:
  1. GET https://www.toogoodtogo.com/api/surprise-bags/bag/{itemId}
  2. Parse JSON response
  3. If !res.success → log warning, skip
  4. If res.payload.itemsAvailable == 0 → log debug, skip
  5. If res.payload.itemsAvailable > 0:
     a. Extract:
        - displayName = res.payload.item.displayName
        - price = format(res.payload.item.itemPrice) → "$X.XX"
        - pickupInterval = res.payload.pickupInterval
        - pickupAddress = res.payload.pickupLocation.address.addressLine
     b. Check notifications table for (itemId, today)
        - If count >= 10 → log "daily limit reached", skip notification
        - Else → send Gotify message, increment count
     c. Update items table: count = itemsAvailable, date = today
```

### Price Formatting

`res.payload.item.itemPrice` likely has `{ code, minorUnits, decimals }` structure. Format as:
```
"$" + (minorUnits / 10^decimals).toFixed(decimals)
```

### Gotify Notification

```
POST {GOTIFY_URL}/message
Headers: X-Gotify-Key: {GOTIFY_TOKEN}
Body: {
  title: "TGTG: {displayName} available!",
  message: "{count} bags @ {price}\nPickup: {pickupInterval}\nAddress: {pickupAddress}",
  priority: 5
}
```

## Frontend (Single Page)

```
┌──────────────────────────────┐
│  TGTG Monitor     [Logout]  │
├──────────────────────────────┤
│                              │
│  Add Item: [________] [Add] │
│                              │
│  Monitored Items:            │
│  ┌──────────────────────┐   │
│  │ 233611          [Del] │   │
│  │ 235541          [Del] │   │
│  │ 235571          [Del] │   │
│  └──────────────────────┘   │
│                              │
└──────────────────────────────┘
```

- Login page: username + password form
- Main page: list items, add/delete items
- No frameworks, just fetch API calls

## Project Structure

```
tgtg/
├── tgtg.db
├── package.json
├── server.js            # Express app + polling logic
├── public/
│   ├── index.html       # Login + main UI (single page)
│   ├── style.css
│   └── app.js           # Frontend logic
└── .env                 # Environment variables
```

## Key Behaviors

1. **Polling starts on server boot** - runs every 60s regardless of frontend
2. **Daily notification cap** - max 10 Gotify messages per itemId per day, resets at midnight (based on date string comparison)
3. **Graceful handling** - if TGTG API is down or returns errors, log and continue to next item
4. **No duplicate items** - itemId is PRIMARY KEY, adding existing ID is a no-op or update
5. **Notification cleanup** - at the start of each polling cycle, delete rows from `notifications` where `date < today - NOTIFICATION_RETENTION_DAYS` (default 7 days)
