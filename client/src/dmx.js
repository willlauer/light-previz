// WebSocket DMX client + patch resolution.
//
// The server pushes a binary payload at ~60Hz:
//   [u16 universeCount] then for each universe [u16 universe, 512 bytes]
//
// We keep `state.universes[universe] = Uint8Array(512)` updated in place so
// per-frame resolveDmx() reads are O(channels per fixture).

export function connectDmx({ url, onStatus, onUniverses, onOpen }) {
  const state = { universes: {}, status: 'connecting', ws: null };
  let knownUniverses = '';

  function open() {
    onStatus?.('connecting');
    const ws = new WebSocket(url);
    state.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      state.status = 'open';
      onStatus?.('open');
      onOpen?.();
    };
    ws.onclose = () => {
      state.status = 'closed';
      onStatus?.('closed');
      setTimeout(open, 1000); // auto-reconnect
    };
    ws.onerror = () => {
      // onclose will fire and we reconnect there
    };
    ws.onmessage = (ev) => {
      const buf = ev.data;
      if (!(buf instanceof ArrayBuffer) || buf.byteLength < 2) return;
      const view = new DataView(buf);
      const count = view.getUint16(0, true);
      let p = 2;
      const changed = [];
      for (let i = 0; i < count; i++) {
        if (p + 2 + 512 > buf.byteLength) break;
        const univ = view.getUint16(p, true); p += 2;
        let slot = state.universes[univ];
        if (!slot) {
          slot = state.universes[univ] = new Uint8Array(512);
          changed.push(univ);
        }
        slot.set(new Uint8Array(buf, p, 512));
        p += 512;
      }
      if (changed.length) {
        const ids = Object.keys(state.universes).map(Number).sort((a, b) => a - b);
        const key = ids.join(',');
        if (key !== knownUniverses) {
          knownUniverses = key;
          onUniverses?.(ids);
        }
      }
    };
  }
  open();
  return state;
}

// Send a JSON control message over the active WebSocket (or no-op if not
// connected). Used to register the patch with the server's synth.
export function sendDmxMessage(state, obj) {
  if (!state.ws || state.ws.readyState !== 1) return;
  try { state.ws.send(JSON.stringify(obj)); } catch {}
}

// Given a fixture's patch entry + profile, read DMX from the current `state`.
// Returns a normalized params object that fixtures.js knows how to render.
//
//   patch    = { universe, startAddress } (startAddress is 1-indexed DMX)
//   profile  = { offsets?, segmentOffsets?, segments?, strobe?, defaults? }
export function resolveDmx(state, patch, profile) {
  const univ = state.universes[patch.universe];
  const base = patch.startAddress - 1; // convert to 0-indexed slot
  const params = {};

  const readByte = (offset) => {
    if (!univ) return 0;
    const idx = base + offset;
    if (idx < 0 || idx >= 512) return 0;
    return univ[idx];
  };

  if (profile.offsets) {
    for (const [name, off] of Object.entries(profile.offsets)) {
      params[name] = readByte(off);
    }
  }
  // Apply defaults for params the profile doesn't expose on DMX
  if (profile.defaults) {
    for (const [name, val] of Object.entries(profile.defaults)) {
      if (params[name] == null) params[name] = val;
    }
  }
  // Per-segment values (bar fixtures)
  if (profile.segmentOffsets) {
    const segCount = profile.segments || 0;
    const segs = new Array(segCount);
    for (let i = 0; i < segCount; i++) segs[i] = { r: 255, g: 255, b: 255, dimmer: 255 };
    for (const [name, offsets] of Object.entries(profile.segmentOffsets)) {
      for (let i = 0; i < offsets.length && i < segCount; i++) {
        const v = readByte(offsets[i]);
        if (name === 'red') segs[i].r = v;
        else if (name === 'green') segs[i].g = v;
        else if (name === 'blue') segs[i].b = v;
        else if (name === 'dimmer') segs[i].dimmer = v;
      }
    }
    params.segments = segs;
  }
  return params;
}
