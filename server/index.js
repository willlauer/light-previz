import dgram from 'node:dgram';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
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
const OP_POLL = 0x2000;       // ArtPoll      — controller asks "who's out there?"
const OP_POLLREPLY = 0x2100;  // ArtPollReply — node answers "here I am"
const OP_DMX = 0x5000;

const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

sock.on('error', (err) => {
  console.error('[artnet] socket error', err);
});

// ─── ArtPollReply (device discovery) ────────────────────────────────────────
//
// Controllers like Soundswitch don't blindly fire DMX at a port — they first
// broadcast an ArtPoll and only list/output to nodes that answer with an
// ArtPollReply. Without this the device list stays on "No device found" and
// no DMX is ever sent. We advertise ourselves as a single-port DMX *output*
// node on universe 0 (we still accept any universe in the DMX handler below).
//
// Packet layout per the Art-Net 4 spec (234 bytes). Anything we don't set
// stays zero, which is valid.
const POLLREPLY_LEN = 234;

function localIPv4() {
  // In WSL mirrored mode this is the Windows LAN IP; otherwise the eth0 IP.
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '0.0.0.0';
}

function buildPollReply() {
  const buf = Buffer.alloc(POLLREPLY_LEN);
  ARTNET_HEADER.copy(buf, 0);                 // 0..7   "Art-Net\0"
  buf.writeUInt16LE(OP_POLLREPLY, 8);         // 8..9   OpCode (little-endian)

  const ip = localIPv4().split('.').map(Number);
  buf[10] = ip[0]; buf[11] = ip[1]; buf[12] = ip[2]; buf[13] = ip[3]; // 10..13 IP
  buf.writeUInt16LE(ARTNET_PORT, 14);         // 14..15 Port (0x1936)

  buf[16] = 0x00; buf[17] = 0x01;             // 16..17 firmware version
  buf[18] = 0x00;                             // 18     NetSwitch (net 0)
  buf[19] = 0x00;                             // 19     SubSwitch (subnet 0)
  buf.writeUInt16BE(0x00ff, 20);              // 20..21 OEM (0x00ff = unknown)
  buf[23] = 0xd0;                             // 23     Status1 (indicators normal)
  buf.writeUInt16LE(0x7fff, 24);              // 24..25 ESTA man. code (prototype)

  buf.write('lightviz', 26, 17, 'ascii');                       // 26..43  ShortName[18]
  buf.write('lightviz Art-Net bridge', 44, 63, 'ascii');        // 44..107 LongName[64]
  buf.write('#0001 [0000] lightviz OK', 108, 63, 'ascii');      // 108..171 NodeReport[64]

  buf[172] = 0x00; buf[173] = 0x01;           // 172..173 NumPorts = 1
  buf[174] = 0x80;                            // 174 PortTypes[0]: DMX output port
  buf[182] = 0x80;                            // 182 GoodOutput[0]: data transmitting
  buf[190] = 0x00;                            // 190 SwOut[0]: universe 0 (low nibble)
  buf[200] = 0x00;                            // 200 Style = StNode
  buf[207] = ip[0]; buf[208] = ip[1]; buf[209] = ip[2]; buf[210] = ip[3]; // BindIp
  buf[211] = 0x01;                            // 211 BindIndex
  buf[212] = 0x08;                            // 212 Status2: supports 15-bit addressing
  return buf;
}

let pollReplyCount = 0;
function replyToPoll(rinfo) {
  const reply = buildPollReply();
  // Reply straight back to the polling controller on the Art-Net port. (Spec
  // allows broadcast; unicast to the sender is enough for Soundswitch.)
  sock.send(reply, ARTNET_PORT, rinfo.address, (err) => {
    if (err) console.warn('[artnet] ArtPollReply send failed', err.message);
  });
  if (pollReplyCount++ === 0) {
    console.log(`[artnet] ArtPoll from ${rinfo.address}:${rinfo.port} → replied (advertising universe 0 output)`);
  }
}

// Packet rate counters — printed once a second so you can confirm the
// stream is healthy without spamming on every packet.
const packetCounts = {};        // universe -> packets/sec
const packetSources = {};       // universe -> last seen source ip:port

function onArtNetMessage(msg, rinfo) {
  if (msg.length < 18) return;
  if (!msg.subarray(0, 8).equals(ARTNET_HEADER)) return;

  const opcode = msg.readUInt16LE(8);
  if (opcode === OP_POLL) { replyToPoll(rinfo); return; }
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

  packetCounts[universe] = (packetCounts[universe] || 0) + 1;
  packetSources[universe] = `${rinfo.address}:${rinfo.port}`;

  if (!seenUniverses.has(universe)) {
    seenUniverses.add(universe);
    console.log(
      `[artnet] first packet on universe ${universe} (net=${(universe >> 8) & 0x7f} sub=${(universe >> 4) & 0xf} uni=${universe & 0xf}) from ${rinfo.address}:${rinfo.port}, ${slots} slots`
    );
  }
}

sock.on('message', onArtNetMessage);

// Per-second packet-rate summary. Useful when verifying the stream is
// actually arriving (a typical Soundswitch output is 30-44 packets/sec
// per universe).
setInterval(() => {
  const lines = [];
  for (const u of Object.keys(packetCounts)) {
    if (packetCounts[u] === 0) continue;
    lines.push(`u${u}: ${packetCounts[u]} pkt/s from ${packetSources[u]}`);
  }
  if (lines.length) console.log('[artnet]', lines.join(' · '));
  for (const u of Object.keys(packetCounts)) packetCounts[u] = 0;
}, 1000);

sock.bind(ARTNET_PORT, '0.0.0.0', () => {
  console.log(`[artnet] listening on 0.0.0.0:${ARTNET_PORT} (UDP)`);
});

// ─── Dedicated loopback socket (Windows same-machine Soundswitch) ────────────
//
// When Soundswitch runs on the SAME machine as this bridge and "Localhost
// Art-Net Node" is enabled, it emits DMX to 127.0.0.1:6454. Soundswitch is
// itself bound to 0.0.0.0:6454, so that loopback unicast can be delivered to
// *its* socket instead of ours (Windows shared-port "last binder wins" for
// unicast). Binding a second socket to the specific 127.0.0.1 address wins the
// loopback delivery by longest-prefix match, making same-box capture reliable.
// On Linux/macOS this simply also receives loopback traffic; harmless either way.
const loopSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
loopSock.on('error', (err) => {
  // Non-fatal: if the OS won't allow the extra bind, the 0.0.0.0 socket above
  // still handles everything (and on non-Windows it usually isn't needed).
  console.warn('[artnet] loopback socket unavailable (non-fatal):', err.message);
});
loopSock.on('message', onArtNetMessage);
loopSock.bind(ARTNET_PORT, '127.0.0.1', () => {
  console.log(`[artnet] also listening on 127.0.0.1:${ARTNET_PORT} (same-machine Soundswitch)`);
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
