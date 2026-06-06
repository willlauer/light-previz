import * as THREE from 'three';
import { createBeam, setBeam } from './beam.js';

const tmpColor = new THREE.Color();

// ─── Public API ────────────────────────────────────────────────────────────
//
// Each fixture is structured as:
//
//   root  (THREE.Group, position = [x, 0, z])
//     ├── base       (only if mount === "floor")
//     └── aim        (THREE.Group, position = [0, mountY, 0], rotation = aim)
//           ├── body, lens, halo, beam, spot   (par)
//           ├── body, segments, segLights      (bar)
//
// Dragging slides `root` in the XZ plane only. The aim group is unchanged,
// so the beam direction relative to the fixture stays the same — moving the
// fixture is equivalent to physically picking it up and walking it across
// the floor.
//
// Truss-mounted fixtures have the same structure but no base disc, and
// the drag system skips them.

const Z_AXIS_NEG_Y = new THREE.Vector3(0, -1, 0);

export function createFixture(entry, profile) {
  const root = new THREE.Group();
  root.name = entry.fixtureId;

  const pos = entry.position || [0, 4, 0];
  root.position.set(pos[0], 0, pos[2]);

  const mountY = pos[1];
  const mount = entry.mount || (mountY > 2 ? 'truss' : 'floor');

  // Inner group: this is where the fixture body actually lives. Position it
  // at the mount height; aim it later. Dragging won't touch this group.
  const aim = new THREE.Group();
  aim.position.y = mountY;
  root.add(aim);

  // Floor base — only for floor mounts. Helps the user see what's
  // draggable, and visually "plants" the fixture.
  if (mount === 'floor') {
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.28, 0.05, 24),
      new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.6, metalness: 0.4 }),
    );
    base.position.y = 0.025;
    root.add(base);
  }

  if (profile.type === 'bar') {
    return buildBar(root, aim, entry, profile, mount, pos, mountY);
  }
  if (profile.type === 'wedge') {
    return buildWedge(root, aim, entry, profile, mount, pos, mountY);
  }
  // Default + 'par'
  return buildPar(root, aim, entry, profile, mount, pos, mountY);
}

// ─── Par / wash fixture ────────────────────────────────────────────────────
function buildPar(root, aim, entry, profile, mount, pos, mountY) {
  // Body
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.18, 0.3, 16),
    new THREE.MeshStandardMaterial({ color: 0x202225, roughness: 0.6, metalness: 0.6 }),
  );
  aim.add(body);

  // LEDs on the front face. If the profile declares concentric rings (like
  // the LaluceNatz 36-LED par), we render a cluster of small dots — one disc
  // per LED — so the fixture reads as a multi-LED par. Otherwise fall back
  // to a single large lens disc (generic par).
  const leds = [];
  if (Array.isArray(profile.ledRings) && profile.ledRings.length > 0) {
    for (const ring of profile.ledRings) {
      const count = ring.count;
      const radius = ring.radius;
      // 0-offset shift each ring slightly so they don't all align
      const angleOffset = (ring.angleOffset ?? 0);
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + angleOffset;
        const x = Math.cos(a) * radius;
        const z = Math.sin(a) * radius;
        const led = new THREE.Mesh(
          new THREE.CircleGeometry(0.014, 10),
          new THREE.MeshBasicMaterial({
            color: 0x000000, side: THREE.DoubleSide, toneMapped: false,
          }),
        );
        led.position.set(x, -0.155, z);
        led.rotation.x = Math.PI / 2;
        led.raycast = () => {};
        aim.add(led);
        leds.push(led);
      }
    }
  } else {
    // Single big lens — generic par
    const lens = new THREE.Mesh(
      new THREE.CircleGeometry(0.16, 24),
      new THREE.MeshBasicMaterial({
        color: 0x000000, side: THREE.DoubleSide, toneMapped: false,
      }),
    );
    lens.position.y = -0.155;
    lens.rotation.x = Math.PI / 2;
    lens.raycast = () => {};
    aim.add(lens);
    leds.push(lens);
  }

  // Halo — additive disc behind the lens for off-angle readability
  const halo = new THREE.Mesh(
    new THREE.CircleGeometry(0.22, 24),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true, opacity: 0.6,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false,
    }),
  );
  halo.position.y = -0.16;
  halo.rotation.x = Math.PI / 2;
  halo.raycast = () => {};
  aim.add(halo);

  // U-shaped yoke bracket — the iconic "par can" mounting frame. Two side
  // bars flanking the body, joined behind by a back bar. Cosmetic only.
  const yokeMat = new THREE.MeshStandardMaterial({
    color: 0x303338, roughness: 0.4, metalness: 0.7,
  });
  for (const side of [-1, 1]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.36, 0.02), yokeMat);
    bar.position.set(side * 0.21, 0, 0);
    bar.raycast = () => {};
    aim.add(bar);
  }
  const backBar = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.02, 0.02), yokeMat);
  backBar.position.set(0, 0.18, 0);
  backBar.raycast = () => {};
  aim.add(backBar);

  // Aim the inner group. We capture the resulting quaternion as the "base"
  // so the yaw control can spin the fixture around the world Y axis on top
  // of the patch.json aim, without losing the aim direction.
  const aimWorld = entry.aim
    ? new THREE.Vector3(entry.aim[0], entry.aim[1], entry.aim[2])
    : new THREE.Vector3(pos[0], 0, pos[2]);
  const fromWorld = new THREE.Vector3(pos[0], mountY, pos[2]);
  orientGroupAt(aim, fromWorld, aimWorld);
  const baseQuaternion = aim.quaternion.clone();

  // Visible beam
  const beamAngleDeg = profile.beamAngle || 30;
  const beam = createBeam({
    color: new THREE.Color(1, 1, 1),
    length: 14,
    radius: 14 * Math.tan((beamAngleDeg / 2) * Math.PI / 180),
  });
  aim.add(beam);

  // Real SpotLight — illuminates scene geometry
  const spot = new THREE.SpotLight(0xffffff, 0, 30, (beamAngleDeg / 2) * Math.PI / 180 * 1.4, 0.5, 1.0);
  spot.position.set(0, 0, 0);
  spot.target.position.set(0, -1, 0);
  aim.add(spot);
  aim.add(spot.target);

  return {
    group: root, patch: entry, profile,
    type: 'par', kind: 'par', mount,
    aim, body, beam, leds, halo, spot,
    yaw: 0,
    baseQuaternion,
  };
}

// ─── Wedge fixture (Rockville RockWedge — 3 × RGBWA+UV LEDs on angled top) ─
//
// Form factor (per the manual): a small rectangular block, ~6.69 × 6.69 × 8.86
// inches, with the top face cut at an angle. 3 LEDs are arranged in a triangle
// on that angled face. It's a floor uplight — sits flat on the ground, and
// yaw determines which way the angled face points. Pitch is FIXED by the
// wedge geometry, so unlike `par` we don't tilt the body to match aim — we
// only yaw it to face the aim direction.

const WEDGE_WIDTH = 0.17;      // X (left-right)
const WEDGE_DEPTH = 0.14;      // Z (front-back)
const WEDGE_H_SHORT = 0.13;    // front vertical height
const WEDGE_H_TALL  = 0.22;    // back vertical height (so top tilts forward)
// LED face normal (unit vector), in the wedge's local frame at yaw=0
const _faceLen = Math.hypot(WEDGE_DEPTH, WEDGE_H_TALL - WEDGE_H_SHORT);
const WEDGE_FACE_NY = WEDGE_DEPTH / _faceLen;
const WEDGE_FACE_NZ = (WEDGE_H_TALL - WEDGE_H_SHORT) / _faceLen;

function buildWedge(root, aim, entry, profile, mount, pos, mountY) {
  // Wedges sit on their own base (on the floor or deck), so we ignore the
  // patch.json mountY and place the body just above the base disc.
  aim.position.y = 0.05;

  // Body — extrude a wedge side-profile (XY) along Z, then rotate -90° around
  // Y so the angled face's outward normal projects onto +Z at yaw=0. That
  // makes yaw=0 point "north" (toward -Z is back, +Z is forward).
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);                            // back-bottom
  shape.lineTo(WEDGE_DEPTH, 0);                  // front-bottom
  shape.lineTo(WEDGE_DEPTH, WEDGE_H_SHORT);      // front-top
  shape.lineTo(0, WEDGE_H_TALL);                 // back-top
  shape.closePath();
  const geom = new THREE.ExtrudeGeometry(shape, { depth: WEDGE_WIDTH, bevelEnabled: false });
  geom.translate(-WEDGE_DEPTH / 2, 0, -WEDGE_WIDTH / 2);
  geom.rotateY(-Math.PI / 2);

  const body = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
    color: 0x1d1f24, roughness: 0.55, metalness: 0.55,
  }));
  aim.add(body);

  // Face normal in local space (after the geometry rotation)
  const faceNormal = new THREE.Vector3(0, WEDGE_FACE_NY, WEDGE_FACE_NZ);

  // 3 LEDs on the angled face, parameterized by (u, v):
  //   u = 0 at front-low end, 1 at back-high end
  //   v = 0 at left, 1 at right
  // Triangle layout: one top-center, two bottom (front), spread left/right.
  const ledUV = [
    { u: 0.75, v: 0.50 },
    { u: 0.28, v: 0.27 },
    { u: 0.28, v: 0.73 },
  ];

  const ledPositions = ledUV.map(({ u, v }) => new THREE.Vector3(
    -WEDGE_WIDTH / 2 + v * WEDGE_WIDTH,
    WEDGE_H_SHORT + u * (WEDGE_H_TALL - WEDGE_H_SHORT),
     WEDGE_DEPTH / 2 - u * WEDGE_DEPTH,
  ));

  // Quaternion that rotates +Z (CircleGeometry's normal) onto the face normal
  const lensQuat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1), faceNormal,
  );

  const leds = [];
  for (const p of ledPositions) {
    const lens = new THREE.Mesh(
      new THREE.CircleGeometry(0.028, 24),
      new THREE.MeshBasicMaterial({
        color: 0x000000, side: THREE.DoubleSide, toneMapped: false,
      }),
    );
    // Push the disc 1mm out of the face so it doesn't z-fight with the body
    lens.position.copy(p).addScaledVector(faceNormal, 0.001);
    lens.quaternion.copy(lensQuat);
    lens.raycast = () => {};
    aim.add(lens);
    leds.push(lens);
  }

  // 3 beams, one per LED, each emerging along the face normal.
  // createBeam returns a mesh whose apex sits at local y=-0.155 along -Y.
  // We rotate so local -Y aligns with faceNormal, then position so the apex
  // lands exactly at the LED.
  const beamAngleDeg = (profile.beamAngle || 30);
  const beamRot = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, -1, 0), faceNormal,
  );
  const apexOffset = faceNormal.clone().multiplyScalar(0.155);
  const beams = [];
  for (const p of ledPositions) {
    const beam = createBeam({
      color: new THREE.Color(1, 1, 1),
      length: 12,
      // Slightly tighter per-LED beam than the par default
      radius: 12 * Math.tan((beamAngleDeg / 2) * Math.PI / 180) * 0.65,
    });
    beam.position.copy(p).sub(apexOffset);
    beam.quaternion.copy(beamRot);
    aim.add(beam);
    beams.push(beam);
  }

  // One SpotLight per wedge (cheaper than 3) — positioned at the cluster
  // center, aimed along the face normal.
  const center = ledPositions.reduce(
    (acc, p) => acc.add(p), new THREE.Vector3(),
  ).divideScalar(ledPositions.length);
  const spot = new THREE.SpotLight(0xffffff, 0, 30,
    (beamAngleDeg / 2) * Math.PI / 180 * 1.6, 0.5, 1.0);
  spot.position.copy(center);
  spot.target.position.copy(center).add(faceNormal);
  aim.add(spot);
  aim.add(spot.target);

  // Initial yaw — face the aim point. We project aim - pos onto XZ and use
  // atan2(dx, dz) because the wedge's face-normal XZ direction at yaw θ is
  // (sin θ, cos θ).
  const aimX = entry.aim?.[0] ?? pos[0];
  const aimZ = entry.aim?.[2] ?? pos[2];
  const dx = aimX - pos[0];
  const dz = aimZ - pos[2];
  const initialYaw = (dx * dx + dz * dz > 1e-6) ? Math.atan2(dx, dz) : 0;

  const fixture = {
    group: root, patch: entry, profile,
    type: 'wedge', kind: 'wedge', mount,
    aim, body, leds, beams, spot, faceNormal,
    yaw: initialYaw,
    baseQuaternion: new THREE.Quaternion(),  // identity — yaw is the only rotation
  };
  applyParYaw(fixture);  // applies yaw around Y onto aim.quaternion
  return fixture;
}

// ─── Bar fixture (linear segments) ─────────────────────────────────────────
function buildBar(root, aim, entry, profile, mount, pos, mountY) {
  const length = entry.length || 1.0;
  const segments = profile.segments || 1;

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(length, 0.08, 0.08),
    new THREE.MeshStandardMaterial({ color: 0x1a1c1f, roughness: 0.6, metalness: 0.5 }),
  );
  aim.add(body);

  const segWidth = length / segments;
  const segMeshes = [];
  for (let i = 0; i < segments; i++) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(segWidth * 0.85, 0.06),
      new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false }),
    );
    const x = -length / 2 + segWidth * (i + 0.5);
    mesh.position.set(x, 0, 0.041);
    segMeshes.push(mesh);
    aim.add(mesh);
  }

  // Rotation is applied by applyBarOrientation() once the fixture object is
  // assembled, so we can also handle horizontal/vertical switching cleanly.

  // PointLights spread along the bar
  const lightCount = Math.min(4, segments);
  const segLights = [];
  for (let i = 0; i < lightCount; i++) {
    const frac = (i + 0.5) / lightCount;
    const pl = new THREE.PointLight(0xffffff, 0, 8, 2);
    pl.position.set(-length / 2 + length * frac, -0.1, 0.05);
    aim.add(pl);
    segLights.push({
      light: pl,
      segStart: Math.floor(segments * i / lightCount),
      segEnd: Math.floor(segments * (i + 1) / lightCount),
    });
  }

  const fixture = {
    group: root, patch: entry, profile,
    type: 'bar', kind: 'bar', mount,
    aim, body, segMeshes, segLights,
    length,
    orientation: entry.orientation || 'horizontal',
    yaw: (entry.rotation && entry.rotation[1]) || 0,
    baseMountY: mountY,
  };
  // Apply initial orientation (also re-applies whatever entry.orientation was)
  applyBarOrientation(fixture);
  return fixture;
}

// Toggle a bar between lying flat and standing upright. Only affects the
// inner aim group, so dragging (which moves the root) is unaffected.
//
// Horizontal: bar's long axis along local X (default geometry), centered at
//   the patch.json mount height.
// Vertical: bar's long axis along local Y. Position is bumped up so the
//   bottom of the bar sits just above the floor base disc, regardless of
//   what mount height was in patch.json.
export function setBarOrientation(fixture, orientation) {
  if (fixture.kind !== 'bar') return;
  fixture.orientation = orientation;
  applyBarOrientation(fixture);
}

// Rotate a bar around the world Y axis (yaw). Applied on top of the H/V
// orientation; for vertical bars this spins them around their own long axis.
export function setBarYaw(fixture, yawRad) {
  if (fixture.kind !== 'bar') return;
  fixture.yaw = yawRad;
  applyBarOrientation(fixture);
}

// Unified yaw setter — works for both pars and bars. For pars, yaw spins the
// fixture around the world Y axis on top of its baked aim direction (so an
// uplight aimed up-and-left becomes up-and-forward when yawed 90°).
export function setFixtureYaw(fixture, yawRad) {
  if (fixture.kind === 'bar') {
    fixture.yaw = yawRad;
    applyBarOrientation(fixture);
  } else if (fixture.kind === 'par' || fixture.kind === 'wedge') {
    fixture.yaw = yawRad;
    applyParYaw(fixture);
  }
}

function applyParYaw(fixture) {
  _qYaw.setFromAxisAngle(_vY, fixture.yaw || 0);
  fixture.aim.quaternion.multiplyQuaternions(_qYaw, fixture.baseQuaternion);
}

// Reusable scratch quats so we don't allocate per frame
const _qYaw = new THREE.Quaternion();
const _qVert = new THREE.Quaternion();
const _vY = new THREE.Vector3(0, 1, 0);
const _vZ = new THREE.Vector3(0, 0, 1);

function applyBarOrientation(fixture) {
  // Compose two world-axis rotations:
  //   1. qVert: only for vertical orientation; rotates the bar's long axis
  //      from world X onto world Y (a Z-axis 90° tilt)
  //   2. qYaw : a Y-axis rotation around world up
  //
  // We multiply as `qYaw * qVert` so qVert is applied first (stand the bar
  // up), then qYaw spins the standing bar around the world Y axis. This
  // intentionally ignores any X/Z components of patch.json's rotation
  // (pitch/roll on a floor bar isn't a thing we currently expose).
  _qYaw.setFromAxisAngle(_vY, fixture.yaw || 0);
  if (fixture.orientation === 'vertical') {
    _qVert.setFromAxisAngle(_vZ, Math.PI / 2);
    fixture.aim.quaternion.multiplyQuaternions(_qYaw, _qVert);
    fixture.aim.position.y = fixture.length / 2 + 0.06;
  } else {
    fixture.aim.quaternion.copy(_qYaw);
    fixture.aim.position.y = fixture.baseMountY;
  }
}

// Orient `group` so its local -Y axis points from `fromWorld` toward `target`.
function orientGroupAt(group, fromWorld, target) {
  const dir = new THREE.Vector3().subVectors(target, fromWorld);
  if (dir.lengthSq() < 1e-6) dir.set(0, -1, 0);
  dir.normalize();
  group.quaternion.setFromUnitVectors(Z_AXIS_NEG_Y, dir);
}

// ─── Per-frame update ──────────────────────────────────────────────────────
export function updateFixture(fixture, params, timeSec) {
  if (fixture.kind === 'par') updatePar(fixture, params, timeSec);
  else if (fixture.kind === 'bar') updateBar(fixture, params, timeSec);
  else if (fixture.kind === 'wedge') updateWedge(fixture, params, timeSec);
}

function updatePar(fixture, params, timeSec) {
  const dimmer = (params.dimmer ?? 255) / 255;
  let r = (params.red   ?? 0) / 255;
  let g = (params.green ?? 0) / 255;
  let b = (params.blue  ?? 0) / 255;

  const w = (params.white ?? 0) / 255;
  const a = (params.amber ?? 0) / 255;
  const uv = (params.uv ?? 0) / 255;
  r += w + a * 1.0 + uv * 0.5;
  g += w + a * 0.6;
  b += w * 0.95 + uv * 1.0;

  const strobe = params.strobe ?? 0;
  let gate = 1;
  if (strobe > (fixture.profile.strobe?.threshold ?? 10)) {
    const hz = THREE.MathUtils.mapLinear(strobe, 10, 255, 1, 20);
    gate = (Math.sin(timeSec * hz * Math.PI * 2) > 0) ? 1 : 0;
  }
  const intensity = dimmer * gate;

  const cr = Math.min(r, 1.5);
  const cg = Math.min(g, 1.5);
  const cb = Math.min(b, 1.5);

  tmpColor.setRGB(cr, cg, cb);
  const beamI = Math.min(1.0, intensity) * 1.4;
  setBeam(fixture.beam, tmpColor, beamI * Math.max(cr + cg + cb, 0.0) * 0.5);

  // LED dot(s) — one big lens for a generic par, or 36 small dots for a
  // LaluceNatz-style cluster. All driven with the same color since they're
  // a single light source from a DMX standpoint.
  for (const led of fixture.leds) {
    led.material.color.setRGB(cr * intensity, cg * intensity, cb * intensity);
  }
  fixture.halo.material.color.setRGB(cr * intensity * 0.7, cg * intensity * 0.7, cb * intensity * 0.7);

  fixture.spot.color.setRGB(cr, cg, cb);
  fixture.spot.intensity = intensity * 25;
}

function updateBar(fixture, params, timeSec) {
  const dimmer = (params.dimmer ?? 255) / 255;
  const segments = fixture.segMeshes;

  const strobe = params.strobe ?? 0;
  let gate = 1;
  if (strobe > (fixture.profile.strobe?.threshold ?? 10)) {
    const hz = THREE.MathUtils.mapLinear(strobe, 10, 255, 1, 20);
    gate = (Math.sin(timeSec * hz * Math.PI * 2) > 0) ? 1 : 0;
  }
  const masterIntensity = dimmer * gate;

  if (params.segments && params.segments.length) {
    for (let i = 0; i < segments.length; i++) {
      const s = params.segments[i] || { r: 0, g: 0, b: 0, dimmer: 255 };
      const segDim = (s.dimmer ?? 255) / 255;
      const k = masterIntensity * segDim;
      segments[i].material.color.setRGB(
        (s.r / 255) * k,
        (s.g / 255) * k,
        (s.b / 255) * k,
      );
    }
  } else {
    const r = (params.red   ?? 0) / 255 * masterIntensity;
    const g = (params.green ?? 0) / 255 * masterIntensity;
    const b = (params.blue  ?? 0) / 255 * masterIntensity;
    for (const m of segments) m.material.color.setRGB(r, g, b);
  }

  for (const { light, segStart, segEnd } of fixture.segLights) {
    let r = 0, g = 0, b = 0, count = 0;
    for (let i = segStart; i < segEnd; i++) {
      const c = segments[i]?.material.color;
      if (c) { r += c.r; g += c.g; b += c.b; count++; }
    }
    if (count > 0) { r /= count; g /= count; b /= count; }
    const lum = Math.max(r, g, b);
    if (lum > 0.001) {
      light.color.setRGB(r / lum, g / lum, b / lum);
      light.intensity = lum * 6;
    } else {
      light.intensity = 0;
    }
  }
}

// Wedge — 3 LEDs (RGBWA+UV) on an angled face. Same color-resolution as a
// par (W/A/UV folded into RGB), applied uniformly to all 3 LED discs/beams
// and the single shared SpotLight.
function updateWedge(fixture, params, timeSec) {
  const dimmer = (params.dimmer ?? 255) / 255;
  let r = (params.red   ?? 0) / 255;
  let g = (params.green ?? 0) / 255;
  let b = (params.blue  ?? 0) / 255;

  const w = (params.white ?? 0) / 255;
  const a = (params.amber ?? 0) / 255;
  const uv = (params.uv ?? 0) / 255;
  r += w + a * 1.0 + uv * 0.5;
  g += w + a * 0.6;
  b += w * 0.95 + uv * 1.0;

  const strobe = params.strobe ?? 0;
  let gate = 1;
  if (strobe > (fixture.profile.strobe?.threshold ?? 10)) {
    const hz = THREE.MathUtils.mapLinear(strobe, 10, 255, 1, 20);
    gate = (Math.sin(timeSec * hz * Math.PI * 2) > 0) ? 1 : 0;
  }
  const intensity = dimmer * gate;

  const cr = Math.min(r, 1.5);
  const cg = Math.min(g, 1.5);
  const cb = Math.min(b, 1.5);

  const beamColor = tmpColor.setRGB(cr, cg, cb);
  const beamI = Math.min(1.0, intensity) * 1.2;
  const beamI_scaled = beamI * Math.max(cr + cg + cb, 0.0) * 0.5;
  for (const beam of fixture.beams) setBeam(beam, beamColor, beamI_scaled);

  // LED discs (raw color, MeshBasicMaterial)
  for (const lens of fixture.leds) {
    lens.material.color.setRGB(cr * intensity, cg * intensity, cb * intensity);
  }

  fixture.spot.color.setRGB(cr, cg, cb);
  fixture.spot.intensity = intensity * 25;
}
