// server.cjs  — CommonJS, works on Node 18–20 on Render

const express = require('express');

// --- APNs (optional; server still runs without it) ---------------------------
let apn = null;
try { apn = require('apn'); }
catch { console.warn('⚠️  apn not installed; silent push disabled until deps are installed.'); }

// --- ENV --------------------------------------------------------------------
const SECRET     = process.env.SECRET || 'change-me';
const BUNDLE_ID  = process.env.BUNDLE_ID;               // e.g. com.watterss.LaptopBattery
const KEY_RAW    = process.env.APNS_KEY ||
                   (process.env.APNS_KEY_BASE64
                     ? Buffer.from(process.env.APNS_KEY_BASE64, 'base64').toString('utf8')
                     : null);
const KEY_ID     = process.env.APNS_KEY_ID;             // e.g. 1A2B3C4D5E
const TEAM_ID    = process.env.APPLE_TEAM_ID;           // e.g. 9ABCDE1234
const APNS_ENV   = (process.env.APNS_ENV || 'sandbox').toLowerCase(); // 'sandbox' (default) or 'production'

// --- APNs Provider (token-based). Default to SANDBOX while dev/testing ------
const apnProvider = (apn && KEY_RAW && KEY_ID && TEAM_ID)
  ? new apn.Provider({
      token: { key: Buffer.from(KEY_RAW, 'utf8'), keyId: KEY_ID, teamId: TEAM_ID },
      // apn lib uses "production" boolean; true = production, false = sandbox
      production: APNS_ENV === 'production'
    })
  : null;

if (apnProvider) {
  console.log(`📦 APNs ready (${APNS_ENV})`);
} else {
  console.log('ℹ️  APNs provider not initialized (missing apn or key env). Server will still run.');
}

// --- APP --------------------------------------------------------------------
const app = express();
app.use(express.json());

// In-memory stores (swap to Redis/DB in production if you need persistence)
const latest     = new Map(); // deviceId -> { percent, charging, ts }
const apnsTokens = new Map(); // deviceId -> device token for the app
const liveTokens = new Map(); // deviceId -> live activity token (optional)

function authed(req) {
  const s = req.get('x-auth') || req.body?.secret;
  return s && s === SECRET;
}

// Register app device APNs token (called by AppDelegate at launch)
app.post('/register', (req, res) => {
  if (!authed(req)) return res.status(403).json({ error: 'unauthorized' });
  const { deviceId, token } = req.body || {};
  if (!deviceId || !token) return res.status(400).json({ error: 'missing deviceId or token' });
  apnsTokens.set(deviceId, token);
  return res.json({ ok: true });
});

// Register Live Activity push token (called by LiveActivityManager when started)
app.post('/register-live-activity', (req, res) => {
  if (!authed(req)) return res.status(403).json({ error: 'unauthorized' });
  const { deviceId, token } = req.body || {};
  if (!deviceId || !token) return res.status(400).json({ error: 'missing deviceId or token' });
  liveTokens.set(deviceId, token);
  return res.json({ ok: true });
});

// Laptop posts new reading -> we store it, send SILENT push, and (optionally) a Live Activity push
app.post('/battery', async (req, res) => {
  if (!authed(req)) return res.status(403).json({ error: 'unauthorized' });

  const { deviceId, percent, charging } = req.body || {};
  if (!deviceId || typeof percent !== 'number' || typeof charging !== 'boolean') {
    return res.status(400).json({ error: 'bad payload' });
  }

  const data = { percent, charging, ts: Date.now() };
  latest.set(deviceId, data);

  // ---- Silent background push (updates widget + app state) -----------------
  const deviceToken = apnsTokens.get(deviceId);
  if (apnProvider && deviceToken && BUNDLE_ID) {
    const note = new apn.Notification();
    // Required fields for silent push:
    note.topic = BUNDLE_ID;           // app bundle id
    note.pushType = 'background';     // critical: background
    note.priority = 5;                // background priority must be 5 (not 10)
    note.contentAvailable = 1;        // signal background fetch
    // Keep payload lean; include only what app needs
    note.payload = { battery: { percent, charging } };

    try {
      const result = await apnProvider.send(note, deviceToken);
      if (result.failed?.length) console.warn('APNs background failed:', result.failed);
      else                        console.log('APNs background sent:', result.sent?.length || 0);
    } catch (e) {
      console.error('APNs background error:', e);
    }
  }

  // ---- Optional: direct Live Activity push (updates lock screen immediately)
  const laToken = liveTokens.get(deviceId);
  if (apnProvider && laToken && BUNDLE_ID) {
    const la = new apn.Notification();
    // Topic for live activities must be "<bundle id>.push-type.liveactivity"
    la.topic = `${BUNDLE_ID}.push-type.liveactivity`;
    la.pushType = 'liveactivity';
    la.priority = 10; // liveactivity can be high priority
    // Payload structure per Apple docs:
    la.payload = {
      // timestamp required by Apple for liveactivity pushes (seconds)
      aps: { timestamp: Math.floor(Date.now() / 1000) },
      // your activity content-state (must match your attributes ContentState shape)
      'content-state': { percent, charging }
      // optionally 'event' or 'dismissal-date' could be included
    };
    try {
      const laResult = await apnProvider.send(la, laToken);
      if (laResult.failed?.length) console.warn('APNs liveactivity failed:', laResult.failed);
      else                         console.log('APNs liveactivity sent:', laResult.sent?.length || 0);
    } catch (e) {
      console.error('APNs liveactivity error:', e);
    }
  }

  return res.json({ ok: true });
});

// iOS/widget fetch endpoint (used by manual + background refresh)
app.get('/battery/:deviceId', (req, res) => {
  if (!authed(req)) return res.status(403).json({ error: 'unauthorized' });
  const item = latest.get(req.params.deviceId);
  if (!item) return res.status(404).json({ error: 'no data' });
  res.json({ percent: item.percent, charging: item.charging, ts: item.ts });
});

// Health
app.get('/', (_, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Server listening on', PORT));
