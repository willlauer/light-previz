import dgram from 'node:dgram';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const ARTNET_PORT = 6454;
const WS_PORT = 7777;

// ─── State ──────────────────────────────────────────────────────────────────
// universes[universeNum] -> Uint8Array(512)
const universes = {};
// Track which universes we've seen so we can log them once on first sight
const seenUniverses = new Set();

// ─── Art-Net listener ───────────────────────────────────────────────────────
//
// ArtDMX packet format (relevant bytes):
//   0..7   = "Art-Net\0"
//   8..9   = OpCode (little-endian)         0x5000 = ArtDMX
//   10..11 = Protocol version (big-endian)  must be >= 14
//   12     = Sequence
//   13     = Physical
//   14..15 = Universe (little-endian, 15-bit: Net|SubNet|Universe)
//   16..17 = Length of DMX data (big-endian, up to 512)
//   18+    = DMX data
const ARTNET_HEADER = Buffer.from('Art-Net\0');
const OP_DMX = 0x5000;

const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

sock.on('error', (err) => {
  console.error('[artnet] socket error', err);
});

sock.on('message', (msg, rinfo) => {
  if (msg.length < 18) return;
  if (!msg.subarray(0, 8).equals(ARTNET_HEADER)) return;

  const opcode = msg.readUInt16LE(8);
  if (opcode !== OP_DMX) return;

  const universe = msg.readUInt16LE(14);
  const length = msg.readUInt16BE(16);
  if (length === 0 || 18 + length > msg.length) return;

  let buf = universes[universe];
  if (!buf) {
    buf = universes[universe] = new Uint8Array(512);
  }
  // Copy the DMX slots we got. Some senders pad to 512, some send fewer.
  const slots = Math.min(length, 512);
  for (let i = 0; i < slots; i++) buf[i] = msg[18 + i];

  if (!seenUniverses.has(universe)) {
    seenUniverses.add(universe);
    console.log(
      `[artnet] first packet on universe ${universe} (net=${(universe >> 8) & 0x7f} sub=${(universe >> 4) & 0xf} uni=${universe & 0xf}) from ${rinfo.address}:${rinfo.port}`
    );
  }
});

sock.bind(ARTNET_PORT, '0.0.0.0', () => {
  console.log(`[artnet] listening on 0.0.0.0:${ARTNET_PORT} (UDP)`);
});

// ─── WebSocket broadcast ────────────────────────────────────────────────────
// Push the full universes map to all connected clients on a fixed cadence.
// Browser doesn't need every packet — 60Hz of fresh state is plenty for previz.
const httpServer = http.createServer((req, res) => {
  if (req.url === '/patch.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(fs.readFileSync(path.join(ROOT, 'patch.json')));
    return;
  }
  if (req.url?.startsWith('/profiles/')) {
    const name = path.basename(req.url);
    const file = path.join(ROOT, 'profiles', name);
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(fs.readFileSync(file));
      return;
    }
  }
  if (req.url === '/profiles') {
    const files = fs.readdirSync(path.join(ROOT, 'profiles')).filter(f => f.endsWith('.json'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(files));
    return;
  }

  // ─── Model library ──────────────────────────────────────────────────────
  // Discover any directory at the project root that contains a .obj file,
  // and expose its contents over HTTP.
  if (req.url === '/models') {
    const dirs = [];
    for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules' ||
          entry.name === 'client' || entry.name === 'server' ||
          entry.name === 'profiles') continue;
      const dirPath = path.join(ROOT, entry.name);
      const files = fs.readdirSync(dirPath);
      const obj = files.find((f) => f.toLowerCase().endsWith('.obj'));
      if (!obj) continue;
      const mtl = files.find((f) => f.toLowerCase().endsWith('.mtl'));
      dirs.push({
        id:    entry.name,
        name:  entry.name,
        obj,   // filename within the directory
        mtl,   // may be undefined
      });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(dirs));
    return;
  }

  // Static file serving for /models/<dir>/<file>. Path-traversal guarded by
  // resolving against ROOT and checking the result stays inside it.
  if (req.url?.startsWith('/models/')) {
    const decoded = decodeURIComponent(req.url.slice('/models/'.length));
    const target = path.resolve(ROOT, decoded);
    if (!target.startsWith(ROOT + path.sep)) {
      res.writeHead(403); res.end(); return;
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      res.writeHead(404); res.end(); return;
    }
    const ext = path.extname(target).toLowerCase();
    const mime = ({
      '.obj':  'text/plain',
      '.mtl':  'text/plain',
      '.jpg':  'image/jpeg', '.jpeg': 'image/jpeg',
      '.png':  'image/png',
      '.tga':  'image/x-tga',
      '.bmp':  'image/bmp',
    })[ext] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime });
    fs.createReadStream(target).pipe(res);
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });

// ─── Patch registry for synth-mode (client-driven) ──────────────────────────
//
// The client sends `{ type: 'patch', fixtures: [{ universe, startAddress,
// profile }] }` over WS on connect and whenever a fixture is added or
// removed. We keep the latest copy here; the synth uses it to drive only
// the channels that actually belong to fixtures, with profile-correct
// roles (dimmer high, RGB sweeps, strobe/function untouched).
const synthPatch = [];                    // last received patch
const profileCache = new Map();           // name → parsed profile JSON

function loadProfileForSynth(name) {
  if (profileCache.has(name)) return profileCache.get(name);
  const file = path.join(ROOT, 'profiles', `${name}.json`);
  if (!fs.existsSync(file)) {
    profileCache.set(name, null);
    return null;
  }
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    profileCache.set(name, p);
    return p;
  } catch (e) {
    console.warn('[synth] profile parse error', name, e.message);
    profileCache.set(name, null);
    return null;
  }
}

wss.on('connection', (ws) => {
  console.log('[ws] client connected');
  ws.on('close', () => console.log('[ws] client disconnected'));
  ws.on('message', (raw) => {
    // We treat all client→server text frames as JSON control messages.
    try {
      const msg = JSON.parse(raw.toString());
      if (msg && msg.type === 'patch' && Array.isArray(msg.fixtures)) {
        synthPatch.length = 0;
        for (const f of msg.fixtures) {
          synthPatch.push({
            universe: f.universe ?? 0,
            startAddress: f.startAddress,
            profile: f.profile,
          });
          loadProfileForSynth(f.profile);   // warm the cache
        }
        if (process.env.SYNTH === '1') {
          console.log(`[synth] patch updated: ${synthPatch.length} fixtures`);
        }
      }
    } catch {
      // ignore non-JSON or malformed frames
    }
  });
});

setInterval(() => {
  if (wss.clients.size === 0) return;
  // Compact binary payload: [u16 universeCount] then for each universe [u16 universe, 512 bytes]
  const ids = Object.keys(universes);
  if (ids.length === 0) return;
  const payload = Buffer.alloc(2 + ids.length * (2 + 512));
  payload.writeUInt16LE(ids.length, 0);
  let p = 2;
  for (const idStr of ids) {
    const id = Number(idStr);
    payload.writeUInt16LE(id, p); p += 2;
    payload.set(universes[id], p); p += 512;
  }
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}, 1000 / 60);

httpServer.listen(WS_PORT, '0.0.0.0', () => {
  console.log(`[ws] WebSocket + patch HTTP on 0.0.0.0:${WS_PORT}`);
});

// ─── Synthetic DMX for testing without Soundswitch ─────────────────────────
// Enable with: SYNTH=1 npm run server
//
// Profile-aware: we drive only the channels owned by registered fixtures.
// For each fixture we set the dimmer/master to full, do a phase-offset
// sin sweep on R/G/B (and per-segment R/G/B for bars), and leave strobe,
// function, effects, etc. at 0 so we don't trigger their built-in flash
// behaviour and start flickering.
//
// The patch comes from the client over WS (synthPatch); if it's empty
// (e.g. before the client has connected), nothing is driven and the rig
// stays dark, which is a reasonable default.
function writeSynthForFixture(buf, fx, t) {
  const profile = profileCache.get(fx.profile);
  if (!profile) return;
  const base = fx.startAddress - 1;
  if (base < 0 || base >= 512) return;

  const off = profile.offsets || {};
  const phase = t + base * 0.02;
  const s = (p) => Math.round(127 + 127 * Math.sin(p));

  // Master / dimmer — full bright
  if (off.dimmer !== undefined)  buf[base + off.dimmer]  = 255;

  // RGB sweep
  if (off.red   !== undefined)   buf[base + off.red]   = s(phase);
  if (off.green !== undefined)   buf[base + off.green] = s(phase + 2.1);
  if (off.blue  !== undefined)   buf[base + off.blue]  = s(phase + 4.2);

  // RGBWA+UV extras stay at 0 — folding white/amber/uv into RGB on the
  // client already accounts for their contribution. Touching them would
  // double-count or wash the colour out.

  // Strobe / function / patternEffect / colorMacro / colorSpeed / speed:
  // intentionally NOT written. They default to 0 which means "off" in
  // every profile we ship.

  // Per-segment bars
  if (profile.segmentOffsets) {
    const segCount = profile.segments || 0;
    const rOff = profile.segmentOffsets.red   || [];
    const gOff = profile.segmentOffsets.green || [];
    const bOff = profile.segmentOffsets.blue  || [];
    const dOff = profile.segmentOffsets.dimmer || [];
    for (let i = 0; i < segCount; i++) {
      const sp = t * 1.6 + base * 0.05 + i * 0.5;
      if (rOff[i] !== undefined) buf[base + rOff[i]] = s(sp);
      if (gOff[i] !== undefined) buf[base + gOff[i]] = s(sp + 2.1);
      if (bOff[i] !== undefined) buf[base + bOff[i]] = s(sp + 4.2);
      if (dOff[i] !== undefined) buf[base + dOff[i]] = 255;
    }
  }
}

if (process.env.SYNTH === '1') {
  console.log('[synth] universe 0 — profile-aware (waiting for patch from client)');
  let t = 0;
  setInterval(() => {
    t += 0.02;
    let buf = universes[0];
    if (!buf) buf = universes[0] = new Uint8Array(512);
    // Start each frame at zero so we don't carry stale data from a fixture
    // that's since been removed.
    buf.fill(0);
    for (const fx of synthPatch) {
      if ((fx.universe ?? 0) !== 0) continue;
      writeSynthForFixture(buf, fx, t);
    }
    if (!seenUniverses.has(0)) {
      seenUniverses.add(0);
      console.log('[synth] universe 0 active');
    }
  }, 1000 / 40);
}
