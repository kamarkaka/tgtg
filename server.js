require('dotenv').config();
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const crypto = require('crypto');
const path = require('path');

// --- Config ---
const PORT = process.env.PORT || 3000;
const USERNAME = process.env.APP_USERNAME || 'admin';
const PASSWORD = process.env.APP_PASSWORD || 'changeme';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production';
const GOTIFY_URL = process.env.GOTIFY_URL;
const GOTIFY_TOKEN = process.env.GOTIFY_TOKEN;
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS, 10) || 60000;
const NOTIFICATION_RETENTION_DAYS = parseInt(process.env.NOTIFICATION_RETENTION_DAYS, 10) || 7;
const MAX_NOTIFICATIONS_PER_DAY = 10;

// --- Database ---
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'tgtg.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    itemId TEXT PRIMARY KEY,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS notifications (
    itemId TEXT NOT NULL,
    date TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (itemId, date),
    FOREIGN KEY (itemId) REFERENCES items(itemId) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS errors (
    itemId TEXT NOT NULL,
    date TEXT NOT NULL,
    PRIMARY KEY (itemId, date),
    FOREIGN KEY (itemId) REFERENCES items(itemId) ON DELETE CASCADE
  );
`);

// --- Express App ---
const app = express();
app.use(express.json());
// Uses default MemoryStore — acceptable for single-user; sessions lost on restart
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' },
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// Auth routes
app.get('/api/session', (req, res) => {
  res.json({ authenticated: !!req.session.authenticated });
});

const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, try again later' },
});

app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  const usernameMatch = username && username.length === USERNAME.length &&
    crypto.timingSafeEqual(Buffer.from(username), Buffer.from(USERNAME));
  const passwordMatch = password && password.length === PASSWORD.length &&
    crypto.timingSafeEqual(Buffer.from(password), Buffer.from(PASSWORD));
  if (usernameMatch && passwordMatch) {
    req.session.authenticated = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// Item routes
app.get('/api/items', requireAuth, (req, res) => {
  const items = db.prepare('SELECT itemId, createdAt FROM items ORDER BY createdAt DESC').all();
  res.json(items);
});

app.post('/api/items', requireAuth, (req, res) => {
  const { itemId } = req.body;
  if (!itemId || typeof itemId !== 'string' || !itemId.trim()) {
    return res.status(400).json({ error: 'itemId is required' });
  }
  try {
    db.prepare('INSERT OR IGNORE INTO items (itemId) VALUES (?)').run(itemId.trim());
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/items/:itemId', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM items WHERE itemId = ?').run(req.params.itemId);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Item not found' });
  }
  res.json({ ok: true });
});

// --- Polling Logic ---
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function formatPrice(itemPrice) {
  if (!itemPrice) return 'N/A';
  const { minorUnits, decimals } = itemPrice;
  if (minorUnits == null || decimals == null) return 'N/A';
  return '$' + (minorUnits / Math.pow(10, decimals)).toFixed(decimals);
}

function formatPickupInterval(interval) {
  if (!interval || !interval.start || !interval.end) return 'N/A';
  const fmt = (iso) => new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/New_York',
  });
  return `${fmt(interval.start)} - ${fmt(interval.end)}`;
}

async function sendGotify(title, message) {
  if (!GOTIFY_URL || !GOTIFY_TOKEN) {
    console.log('[gotify] Not configured, skipping notification');
    return;
  }
  try {
    const res = await fetch(`${GOTIFY_URL}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gotify-Key': GOTIFY_TOKEN,
      },
      body: JSON.stringify({ title, message, priority: 5 }),
    });
    if (!res.ok) {
      console.error(`[gotify] Failed to send: ${res.status} ${res.statusText}`);
    } else {
      console.log(`[gotify] Sent: ${title}`);
    }
  } catch (err) {
    console.error(`[gotify] Error: ${err.message}`);
  }
}

function cleanupOldNotifications() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - NOTIFICATION_RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const notifResult = db.prepare('DELETE FROM notifications WHERE date < ?').run(cutoffStr);
  const errorResult = db.prepare('DELETE FROM errors WHERE date < ?').run(cutoffStr);
  const total = notifResult.changes + errorResult.changes;
  if (total > 0) {
    console.log(`[cleanup] Removed ${total} old rows`);
  }
}

function getDailyCount(itemId, date) {
  const row = db.prepare('SELECT count FROM notifications WHERE itemId = ? AND date = ?').get(itemId, date);
  return row ? row.count : 0;
}

function incrementDailyCount(itemId, date) {
  db.prepare(`
    INSERT INTO notifications (itemId, date, count) VALUES (?, ?, 1)
    ON CONFLICT(itemId, date) DO UPDATE SET count = count + 1
  `).run(itemId, date);
}

// --- Puppeteer Browser ---
function launchBrowser() {
  const launchOpts = { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  return puppeteer.launch(launchOpts);
}

async function fetchWithBrowser(browser, url) {
  const page = await browser.newPage();
  try {
    const response = await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    const status = response.status();
    if (status !== 200) {
      throw new Error(`HTTP ${status}`);
    }
    const text = await page.evaluate(() => document.body.innerText);
    return JSON.parse(text);
  } finally {
    await page.close();
  }
}

async function checkItem(browser, itemId) {
  const url = `https://www.toogoodtogo.com/api/surprise-bags/bag/${itemId}`;
  const today = todayStr();
  try {
    const data = await fetchWithBrowser(browser, url);

    if (!data.success) {
      console.warn(`[check] ${itemId}: success=false`);
      return;
    }

    const displayName = data.payload?.displayName || 'Unknown';
    const available = data.payload?.itemsAvailable;
    if (!available || available <= 0) {
      console.log(`[check] ${itemId} (${displayName}): 0 available`);
      return;
    }
    const price = formatPrice(data.payload.item?.itemPrice);
    const pickupInterval = formatPickupInterval(data.payload.pickupInterval);
    const address = data.payload.pickupLocation?.address?.addressLine || 'N/A';

    console.log(`[check] ${itemId}: ${available} available - ${displayName} @ ${price}`);

    const dailyCount = getDailyCount(itemId, today);
    if (dailyCount >= MAX_NOTIFICATIONS_PER_DAY) {
      console.log(`[check] ${itemId}: daily notification limit reached (${dailyCount}/${MAX_NOTIFICATIONS_PER_DAY})`);
      return;
    }

    const title = `#${dailyCount + 1} TGTG: ${displayName} available!`;
    const message = `${available} bag(s) @ ${price}\nPickup: ${pickupInterval}\nAddress: ${address}\nReserve at https://share.toogoodtogo.com/item/${itemId}`;
    await sendGotify(title, message);
    incrementDailyCount(itemId, today);
  } catch (err) {
    console.error(`[check] ${itemId}: ${err.message}`);
    const { changes } = db.prepare('INSERT OR IGNORE INTO errors (itemId, date) VALUES (?, ?)').run(itemId, today);
    if (changes > 0) {
      await sendGotify(
        `TGTG: Error checking item ${itemId}`,
        `${err.message}\nPlease verify: https://share.toogoodtogo.com/item/${itemId}`
      );
    }
  }
}

async function pollAll() {
  cleanupOldNotifications();
  const items = db.prepare('SELECT itemId FROM items').all();
  if (items.length === 0) {
    console.log('[poll] No items to check');
    return;
  }
  console.log(`[poll] Checking ${items.length} item(s)...`);
  const browser = await launchBrowser();
  try {
    for (let i = 0; i < items.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 1000));
      await checkItem(browser, items[i].itemId);
    }
  } finally {
    await browser.close();
    console.log('[browser] Closed');
  }
}

// --- Start ---
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Polling every ${CHECK_INTERVAL_MS / 1000}s`);
  pollAll();
  setInterval(pollAll, CHECK_INTERVAL_MS);
});
