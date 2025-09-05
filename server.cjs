// server.js (Express + node-apn)
const express = require('express');
const bodyParser = require('body-parser');
const apn = require('apn');

const SECRET    = process.env.SECRET || "change-me-to-a-long-random-string";
const BUNDLE_ID = process.env.BUNDLE_ID;           // e.g. com.watterss.LaptopBattery
const KEY       = process.env.APNS_KEY;            // raw .p8 contents
const KEY_ID    = process.env.APNS_KEY_ID;         // e.g. 1A2B3C4D5E
const TEAM_ID   = process.env.APPLE_TEAM_ID;       // e.g. 9ABCDE1234

// APNs provider (token-based)
const apnProvider = new apn.Provider({
  token: { key: Buffer.from(KEY, 'utf8'), keyId: KEY_ID, teamId: TEAM_ID },
  production: process.env.NODE_ENV === 'production'
});

const app = express();
app.use(bodyParser.json());

// In-memory stores
const latest = new Map();          // deviceId -> { percent, charging, ts }
const apnsToken = new Map();       // deviceId -> device token for app
const liveToken = new Map();       // deviceId -> (optional) live activity push token

function auth(req) {
  const s = req.headers['x-auth'] || req.body.secret;
  return s && s === SECRET;
}

// ---- Registration of APNs token (from AppDelegate on launch) ----
app.post('/register', (req, res) => {
  if (!auth(req)) return res.status(403).json({ error: 'unauthorized' });
  const { deviceId, token } = req.body || {};
  if (!deviceId || !token) return res.status(400).json({ error: 'missing deviceId or token' });
  apnsToken.set(deviceId, token);
  return res.json({ ok: true });
});

// ---- Optional: Live Activity token (we’re not using it directly in this flow) ----
app.post('/register-live-activity', (req, res) => {
  if (!auth(req)) return res.status(403).json({ error: 'unauthorized' });
  const { deviceId, token } = req.body || {};
  if (!deviceId || !token) return res.status(400).json({ error: 'missing deviceId or token' });
  liveToken.set(deviceId, token);
  return res.json({ ok: true });
});

// ---- Laptop posts latest reading ----
app.post('/battery', async (req, res) => {
  if (!auth(req)) return res.status(403).json({ error: 'unauthorized' });
  const { deviceId, percent, charging } = req.body || {};
  if (!deviceId || typeof percent !== 'number' || typeof charging !== 'boolean') {
    return res.status(400).json({ error: 'bad payload' });
  }
  latest.set(deviceId, { percent, charging, ts: Date.now() });

  // Send a SILENT push to the app (so it saves & refreshes widget + live activity)
  const token = apnsToken.get(deviceId);
  if (token && BUNDLE_ID) {
    const note = new apn.Notification();
    note.topic = BUNDLE_ID;             // your app bundle id
    note.pushType = 'background';       // silent
    note.contentAvailable = 1;
    note.payload = { battery: { percent, charging } };

    try {
      const result = await apnProvider.send(note, token);
      // Optional logging
      console.log('APNs push sent:', JSON.stringify(result.sent));
      if (result.failed?.length) console.warn('APNs push failed:', result.failed);
    } catch (e) {
      console.error('APNs error', e);
    }
  }

  return res.json({ ok: true });
});

// ---- iOS/widget fetch endpoint ----
app.get('/battery/:deviceId', (req, res) => {
  if (!auth(req)) return res.status(403).json({ error: 'unauthorized' });
  const item = latest.get(req.params.deviceId);
  if (!item) return res.status(404).json({ error: 'no data' });
  res.json({ percent: item.percent, charging: item.charging, ts: item.ts });
});

app.get('/', (_, res) => res.send('OK'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listening on', PORT));
