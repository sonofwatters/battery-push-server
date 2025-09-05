// server.cjs — Express + native APNs (no external apn lib)
const express = require('express');
const http2 = require('http2');
const crypto = require('crypto');

const SECRET     = process.env.SECRET || 'change-me-to-a-long-random-string';
const BUNDLE_ID  = process.env.BUNDLE_ID;        // e.g. com.watterss.LaptopBattery
const KEY_PEM    = process.env.APNS_KEY || (process.env.APNS_KEY_BASE64
                    ? Buffer.from(process.env.APNS_KEY_BASE64, 'base64').toString('utf8') : null); // .p8
const KEY_ID     = process.env.APNS_KEY_ID;      // e.g. 1A2B3C4D5E
const TEAM_ID    = process.env.APPLE_TEAM_ID;    // e.g. 9ABCDE1234
const APNS_HOST  = process.env.NODE_ENV === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';

// In-memory stores
const latest    = new Map(); // deviceId -> { percent, charging, ts }
const apnsToken = new Map(); // deviceId -> iOS device token (from AppDelegate)
const liveToken = new Map(); // deviceId -> (optional) Live Activity token

// ---- APNs with native http2 ----
let apnsSession = null;
function getApnsSession() {
  if (!apnsSession) apnsSession = http2.connect(APNS_HOST);
  apnsSession.on('error', err => console.error('APNs session error', err));
  apnsSession.on('goaway', () => { try { apnsSession.close(); } catch {} apnsSession = null; });
  return apnsSession;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

function buildJwt() {
  if (!KEY_PEM || !KEY_ID || !TEAM_ID) return null;
  const header  = b64url(JSON.stringify({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: TEAM_ID, iat: Math.floor(Date.now()/1000) }));
  const unsigned = `${header}.${payload}`;
  const sig = crypto.createSign('sha256').update(unsigned)
      .sign({ key: KEY_PEM, dsaEncoding: 'ieee-p1363' }); // ES256 P-256 (r||s)
  return `${unsigned}.${b64url(sig)}`;
}

async function sendSilentPush(deviceToken, payloadObj) {
  if (!BUNDLE_ID) return { skipped: 'missing BUNDLE_ID' };
  const jwt = buildJwt();
  if (!jwt) return { skipped: 'APNs creds missing' };

  const client = getApnsSession();
  const req = client.request({
    ':method': 'POST',
    ':path': `/3/device/${deviceToken}`,
    'apns-topic': BUNDLE_ID,
    'apns-push-type': 'background',
    'authorization': `bearer ${jwt}`,
    'content-type': 'application/json'
  });

  const body = Buffer.from(JSON.stringify(payloadObj));
  req.setEncoding('utf8');

  let resp = '';
  req.on('response', headers => {
    const status = headers[':status'];
    if (status !== 200) {
      console.warn('APNs non-200', status, headers);
    }
  });
  req.on('data', chunk => resp += chunk);
  const done = new Promise(resolve => req.on('end', () => resolve(resp)));
  req.end(body);
  return done;
}

// ---- Express app ----
const app = express();
app.use(express.json());

function authed(req) {
  const s = req.header('x-auth') || req.body?.secret;
  return s && s === SECRET;
}

app.post('/register', (req, res) => {
  if (!authed(req)) return res.status(403).json({ error: 'unauthorized' });
  const { deviceId, token } = req.body || {};
  if (!deviceId || !token) return res.status(400).json({ error: 'missing deviceId or token' });
  apnsToken.set(deviceId, token);
  return res.json({ ok: true });
});

app.post('/register-live-activity', (req, res) => {
  if (!authed(req)) return res.status(403).json({ error: 'unauthorized' });
  const { deviceId, token } = req.body || {};
  if (!deviceId || !token) return res.status(400).json({ error: 'missing deviceId or token' });
  liveToken.set(deviceId, token);
  return res.json({ ok: true });
});

app.post('/battery', async (req, res) => {
  if (!authed(req)) return res.status(403).json({ error: 'unauthorized' });
  const { deviceId, percent, charging } = req.body || {};
  if (!deviceId || typeof percent !== 'number' || typeof charging !== 'boolean') {
    return res.status(400).json({ error: 'bad payload' });
  }
  latest.set(deviceId, { percent, charging, ts: Date.now() });

  const token = apnsToken.get(deviceId);
  if (token) {
    try {
      await sendSilentPush(token, { aps: { 'content-available': 1 }, battery: { percent, charging } });
    } catch (e) {
      console.error('APNs push error', e);
    }
  }
  return res.json({ ok: true });
});

app.get('/battery/:deviceId', (req, res) => {
  if (!authed(req)) return res.status(403).json({ error: 'unauthorized' });
  const item = latest.get(req.params.deviceId);
  if (!item) return res.status(404).json({ error: 'no data' });
  res.json({ percent: item.percent, charging: item.charging, ts: item.ts });
});

app.get('/', (_, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listening on', PORT));
