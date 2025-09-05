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

function sendLiveActivityPush(deviceToken, payload) {
  const client = http2.connect(APNS_ORIGIN);
  const jwtToken = makeAPNsJWT();

  return new Promise((resolve, reject) => {
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      'authorization': `bearer ${jwtToken}`,
      'apns-topic': `${BUNDLE_ID}.push-type.liveactivity`,
      'apns-push-type': 'liveactivity',
      'apns-priority': '10',
      'content-type': 'application/json'
    });
    let resp = '';
    req.setEncoding('utf8');
    req.on('data', c => resp += c);
    req.on('end', () => { client.close(); resolve(resp || 'ok'); });
    req.on('error', e => { 
        let errorReason = e;
        try {
            const parsedResp = JSON.parse(resp);
            if (parsedResp && parsedResp.reason) { errorReason = parsedResp.reason; }
        } catch {}
        client.close(); 
        reject(new Error(errorReason)); 
    });
    req.end(JSON.stringify(payload));
  });
}

// --- routes ---
app.get('/health', (req, res) => res.json({ ok: true, env: APNS_ENV }));

// RE-ADDED: The original endpoint for the C# client to register its deviceId and secret.
app.post('/register', async (req, res) => {
  const { deviceId, secret } = req.body || {};
  if (!deviceId || !secret) return res.status(400).json({ error: 'missing deviceId/secret' });
  // This creates the initial record for the device.
  db.devices[deviceId] = { secret };
  await saveDb();
  console.log('🔗 registered device shell', deviceId);
  res.json({ ok: true });
});

// The endpoint for the iOS app to add its Live Activity token.
app.post('/register-live-activity', async (req, res) => {
  const { deviceId, token, secret } = req.body || {};
  if (!deviceId || !token || !secret) return res.status(400).json({ error: 'missing deviceId/token/secret' });
  // This adds the live activity token to the existing device record.
  db.devices[deviceId] = { ...db.devices[deviceId], liveActivityToken: token, secret };
  await saveDb();
  console.log('🔗 registered live activity', deviceId, token.slice(0, 12) + '…');
  res.json({ ok: true });
});

app.post('/battery', async (req, res) => {
  const { deviceId, secret, percent, charging } = req.body || {};
  if (!deviceId || typeof secret !== 'string') return res.status(400).json({ error: 'missing deviceId/secret' });
  const reg = db.devices[deviceId];
  if (!reg || reg.secret !== secret) return res.status(403).json({ error: 'unauthorized' });
  
  if (!reg.liveActivityToken) {
    console.log('ℹ️ No Live Activity token for', deviceId, '; skipping push.');
    return res.status(200).json({ ok: true, message: 'no live activity registered' });
  }

  const p = Number(percent), c = !!charging;
  db.states[deviceId] = { percent: p, charging: c, updatedAt: Date.now() };
  await saveDb();
  
  try {
    const payload = {
      aps: {
        timestamp: Math.floor(Date.now() / 1000),
        event: 'update',
        'content-state': {
          percent: (p|0),
          charging: c
        }
      }
    };
    const resp = await sendLiveActivityPush(reg.liveActivityToken, payload);
    console.log('🚀 Pushed Live Activity ->', deviceId, p, c, '| APNs:', resp || 'ok');
  } catch (e) {
    const errorMessage = e?.message || e.toString();
    if (errorMessage.includes('BadDeviceToken') || errorMessage.includes('Unregistered')) {
        console.log('🗑️ Stale Live Activity token for', deviceId, '; removing.');
        delete reg.liveActivityToken;
        await saveDb();
    }
    console.error('❌ Live Activity push failed:', errorMessage);
  }
  
  res.json({ ok: true });
});

// --- start server ---
const port = Number(PORT || 8787);
app.listen(port, () => {
  console.log(`Server listening on :${port} (APNs: ${APNS_ENV})`);
});