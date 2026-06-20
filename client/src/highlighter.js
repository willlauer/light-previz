import * as THREE from 'three';

// ─── X-ray object highlighter ───────────────────────────────────────────────
//
// A toggleable overlay that draws an always-on-top, screen-facing marker on
// top of every selectable object (fixtures + extra models). The markers
// disable depth-testing and render last, so an object hidden behind scene
// geometry — a wall, the club shell, or another fixture — still shows a
// clickable dot floating over whatever is occluding it.
//
// The markers are raycast targets: dragging.js gives them pick priority while
// the overlay is on, so clicking any marker selects its object regardless of
// where it sits or what's in front of it.

const NORMAL_COLOR = 0xffcc33;
const SELECTED_COLOR = 0xffffff;
// Scales are in screen-space units (sizeAttenuation is off), so markers keep a
// constant clickable size no matter how far away — or how buried — the object.
const BASE_SCALE = 0.030;
const SELECTED_SCALE = 0.046;

// A white disc with a dark rim, drawn once and shared by every marker. White
// so the per-sprite material colour can tint it (yellow normally, white when
// selected) by simple multiply.
function makeDotTexture() {
  const size = 64;
  const r = size / 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(r, r, r * 0.40, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = size * 0.10;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// `fixtures` and `models` are the live arrays main.js mutates in place; we
// re-read them on every refresh() so newly added / removed objects stay in
// sync. `getSelected()` returns whichever object (fixture or model) is
// currently selected, so the matching marker can be emphasised.
export function createHighlighter({ scene, fixtures, models = [] }) {
  const texture = makeDotTexture();
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);

  let enabled = false;
  let selectedObject = null;        // the selected fixture or model, or null
  const markers = [];               // THREE.Sprite[]
  const _v = new THREE.Vector3();
  const _box = new THREE.Box3();

  function makeMarker(pickTarget) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture,
      color: NORMAL_COLOR,
      sizeAttenuation: false,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
    }));
    sprite.renderOrder = 999;       // draw after everything else → always visible
    sprite.scale.set(BASE_SCALE, BASE_SCALE, 1);
    // dragging.js reads this back on a marker hit to know what to select.
    sprite.userData.pickTarget = pickTarget;
    return sprite;
  }

  // World anchor for a target: a fixture's body sits in its `aim` group; a
  // model uses its bounding-box centre (recomputed each frame so it tracks
  // while dragging).
  function anchorOf(pickTarget, out) {
    if (pickTarget.kind === 'fixture') {
      return pickTarget.fixture.aim.getWorldPosition(out);
    }
    _box.setFromObject(pickTarget.model.group);
    return _box.getCenter(out);
  }

  function positionMarkers() {
    for (const s of markers) s.position.copy(anchorOf(s.userData.pickTarget, _v));
  }

  function styleMarkers() {
    for (const s of markers) {
      const t = s.userData.pickTarget;
      const obj = t.kind === 'fixture' ? t.fixture : t.model;
      const sel = obj === selectedObject;
      s.material.color.setHex(sel ? SELECTED_COLOR : NORMAL_COLOR);
      const sc = sel ? SELECTED_SCALE : BASE_SCALE;
      s.scale.set(sc, sc, 1);
    }
  }

  // Rebuild the marker set from the current fixtures + models.
  function rebuild() {
    for (const s of markers) {
      group.remove(s);
      s.material.dispose();
    }
    markers.length = 0;
    for (const f of fixtures) markers.push(makeMarker({ kind: 'fixture', fixture: f }));
    for (const m of models) markers.push(makeMarker({ kind: 'model', model: m }));
    for (const s of markers) group.add(s);
    styleMarkers();
    positionMarkers();
  }

  return {
    get enabled() { return enabled; },
    // Markers exposed for picking only while the overlay is on.
    get markers() { return enabled ? markers : []; },

    setEnabled(on) {
      enabled = !!on;
      group.visible = enabled;
      if (enabled) rebuild();
    },
    toggle() { this.setEnabled(!enabled); return enabled; },

    // Object set changed (add / remove / scene load) — rebuild if visible.
    refresh() { if (enabled) rebuild(); },

    // Reflect the current selection (fixture or model, or null).
    setSelection(obj) {
      selectedObject = obj || null;
      if (enabled) styleMarkers();
    },

    // Per-frame: keep markers glued to objects that move (drag / DMX).
    update() { if (enabled) positionMarkers(); },
  };
}
