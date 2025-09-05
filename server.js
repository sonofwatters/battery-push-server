// server.js
import express from 'express';
import http2 from 'node:http2';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import fs from 'node:fs/promises';

dotenv.config();

const {
  TEAM_ID, KEY_ID, BUNDLE_ID, APNS_KEY_BASE64, APNS_ENV = 'sandbox', PORT
} = process.env;

// Fail early if a required env var is missing
for (const [k, v] of Object.entries({ TEAM_ID, KEY_ID, BUNDLE_ID, APNS_KEY_BASE64 })) {
  if (!v) {
    console.error(`Missing env var: ${k}`);
    process.exit(1);
  }
}

const P8 = Buffer.from(APNS_KEY_BASE64, 'base64').toString('utf8');
const APNS_ORIGIN = APNS_ENV === 'production'
  ? 'https://api.push.apple.com'
  : 'https://api.sandbox.push.apple.com';

const app = express();
app.use(express.json());

// simple persistence
const DB_FILE = './db.json';
let db = { devices: {}, states: {} };
async function loadDb() { try { db = JSON.parse(await fs.readFile(DB_FILE, 'utf8')); } catch {} }
async function saveDb() { await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2)); }
await loadDb();

// --- APNs helpers ---
function makeAPNsJWT() {
  return jwt.sign({ iss: TEAM_ID, iat: Math.floor(Date.now()/1000) }, P8, {
    algorithm: 'ES256',
    header: { alg: 'ES256', kid: KEY_ID }
  });
}

function sendBackgroundPush(deviceToken, payload) {
  const client = http2.connect(APNS_ORIGIN);
  const jwtToken = makeAPNsJWT();

  return new Promise((resolve, reject) => {
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      'authorization': `bearer ${jwtToken}`,
      'apns-topic': BUNDLE_ID,
      'apns-push-type': 'background',
      'apns-priority': '5',
      'apns-collapse-id': 'battery',
      'content-type': 'application/json'
    });
    let resp = '';
    req.setEncoding('utf8');
    req.on('data', c => resp += c);
    req.on('end', () => { client.close(); resolve(resp || 'ok'); });
    req.on('error', e => { client.close(); reject(e); });
    req.end(JSON.stringify(payload));
  });
}

// --- routes ---
app.get('/health', (req, res) => res.json({ ok: true, env: APNS_ENV }));

app.post('/register', async (req, res) => {
  const { deviceId, token, secret } = req.body || {};
  if (!deviceId || !token || !secret) return res.status(400).json({ error: 'missing deviceId/token/secret' });
  db.devices[deviceId] = { token, secret };
  await saveDb();
  console.log('🔗 registered', deviceId, token.slice(0, 12) + '…');
  res.json({ ok: true });
});

app.post('/battery', async (req, res) => {
  const { deviceId, secret, percent, charging } = req.body || {};
  if (!deviceId || typeof secret !== 'string') return res.status(400).json({ error: 'missing deviceId/secret' });
  const reg = db.devices[deviceId];
  if (!reg || reg.secret !== secret) return res.status(403).json({ error: 'unauthorized' });

  const p = Number(percent), c = !!charging;
  const prev = db.states[deviceId];
  const now = Date.now();
  db.states[deviceId] = { percent: p, charging: c, updatedAt: now, lastPushAt: prev?.lastPushAt || 0 };
  await saveDb();

  const changed = !prev || Math.abs((p|0) - (prev.percent|0)) >= 1;
  const timeOk  = !prev || (now - (prev.lastPushAt || 0) > 5*60*1000);

  if (changed || timeOk) {
    try {
      const payload = { aps: { 'content-available': 1 }, deviceId, battery: { percent: (p|0), charging: c } };
      const resp = await sendBackgroundPush(reg.token, payload);
      db.states[deviceId].lastPushAt = now;
      await saveDb();
      console.log('📣 pushed ->', deviceId, p, c, '| APNs:', resp || 'ok');
    } catch (e) {
      console.error('❌ push failed:', e?.message || e);
    }
  }
  res.json({ ok: true });
});

// NEW: Add a route for the iOS app to pull the latest state
app.get('/battery/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const secret = req.headers['x-auth'];
  const reg = db.devices[deviceId];
  const state = db.states[deviceId];

  if (!reg || reg.secret !== secret) {
    return res.status(403).json({ error: 'unauthorized' });
  }

  if (state) {
    res.json(state);
  } else {
    res.status(404).json({ error: 'no state found for device' });
  }
});


// --- start server ---
const port = Number(PORT || 8787);
app.listen(port, () => {
  console.log(`Server listening on :${port} (APNs: ${APNS_ENV})`);
});