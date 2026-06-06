import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createStage } from './stage.js';
import { createFixture, updateFixture, setBarOrientation, setFixtureYaw } from './fixtures.js';
import { connectDmx, resolveDmx, sendDmxMessage } from './dmx.js';
import { setupDragging } from './dragging.js';
import { createOutliner } from './outliner.js';
import { serializeScene, applyScene, downloadJson, pickJsonFile, showSaveDialog,
         supportsFsAccess, pickSaveFileHandle, pickOpenFileHandle, writeJsonToHandle } from './scene_io.js';
import { pickFixture } from './fixture_picker.js';
import { pickModel, pickScene, loadModel } from './model_loader.js';

// ───────────────────────────────────────────────────────────────────────────
// Scene setup
// ───────────────────────────────────────────────────────────────────────────
const app = document.getElementById('app');
const scene = new THREE.Scene();
// Slightly-blue dark grey — not pitch black, so distant grid lines stay
// readable instead of melting into the void.
scene.background = new THREE.Color(0x1a1f2a);
// Lighter fog so the grid stays visible. The haze slider in the UI lets
// you crank density back up when you want thick beams.
scene.fog = new THREE.FogExp2(0x1a1f2a, 0.012);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 4, 11);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 2.5, 0);
controls.maxDistance = 40;
controls.minDistance = 1.5;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ───────────────────────────────────────────────────────────────────────────
// Stage + trusses
// ───────────────────────────────────────────────────────────────────────────
const stageLights = createStage(scene);

// ───────────────────────────────────────────────────────────────────────────
// Ambient lighting UI
// ───────────────────────────────────────────────────────────────────────────
function bindRange(id, valueId, fmt, onChange) {
  const el = document.getElementById(id);
  const v = valueId ? document.getElementById(valueId) : null;
  const apply = () => {
    const n = parseFloat(el.value);
    if (v) v.textContent = fmt(n);
    onChange(n);
  };
  el.addEventListener('input', apply);
  apply();
}
function bindColor(id, onChange) {
  const el = document.getElementById(id);
  const apply = () => onChange(el.value);
  el.addEventListener('input', apply);
  apply();
}
bindRange('amb-int', 'amb-int-v', (n) => n.toFixed(2), (n) => { stageLights.ambient.intensity = n; });
bindColor('amb-col', (hex) => { stageLights.ambient.color.set(hex); });
bindRange('key-int', 'key-int-v', (n) => n.toFixed(2), (n) => { stageLights.key.intensity = n; });
bindColor('key-col', (hex) => { stageLights.key.color.set(hex); });
bindColor('bg-col',  (hex) => { scene.background.set(hex); scene.fog.color.set(hex); });
bindRange('fog',     'fog-v',     (n) => n.toFixed(3), (n) => { scene.fog.density = n; });
bindRange('exp',     'exp-v',     (n) => n.toFixed(2), (n) => { renderer.toneMappingExposure = n; });

// ───────────────────────────────────────────────────────────────────────────
// HUD elements
// ───────────────────────────────────────────────────────────────────────────
const wsStatus = document.getElementById('ws-status');
const universeList = document.getElementById('universe-list');
const fixtureCountEl = document.getElementById('fixture-count');
const fpsEl = document.getElementById('fps');

// ───────────────────────────────────────────────────────────────────────────
// Load patch + profiles, build fixtures
// ───────────────────────────────────────────────────────────────────────────
const fixtures = [];
const profileCache = new Map();

async function loadProfile(name) {
  if (profileCache.has(name)) return profileCache.get(name);
  const res = await fetch(`/profiles/${name}.json`);
  if (!res.ok) throw new Error(`profile ${name} not found`);
  const profile = await res.json();
  profileCache.set(name, profile);
  return profile;
}

async function loadPatchAndBuild() {
  const res = await fetch('/patch.json');
  const patch = await res.json();
  for (const entry of patch.fixtures) {
    const profile = await loadProfile(entry.profile);
    addFixture(entry);
  }
}

// ─── Dynamic fixture lifecycle ────────────────────────────────────────────
//
// addFixture(def): given a patch-style entry, build the fixture, add it to
// the scene + fixtures array, refresh counters / outliner, and (if its
// position matches a truss slot) mark that slot occupied. Returns the
// fixture wrapper. Caller is responsible for ensuring the profile JSON has
// already been loaded into `profileCache`.
function addFixture(def) {
  const profile = profileCache.get(def.profile);
  if (!profile) {
    console.warn(`addFixture: profile ${def.profile} not loaded; skipping`);
    return null;
  }
  const fixture = createFixture(def, profile);
  scene.add(fixture.group);
  fixtures.push(fixture);
  fixtureCountEl.textContent = String(fixtures.length);
  outliner?.refresh();
  sendPatchToServer();
  // If this fixture's xz matches a truss slot, hide that slot's marker
  if (def.mount === 'truss' && stageLights.trussSlots) {
    const slot = stageLights.trussSlots.find((s) =>
      Math.abs(s.x - def.position[0]) < 0.05 &&
      Math.abs(s.z - def.position[2]) < 0.05,
    );
    if (slot) {
      slot.occupiedBy = fixture;
      slot.marker.visible = false;
    }
  }
  return fixture;
}

function removeFixture(fixture) {
  if (stageLights.trussSlots) {
    for (const slot of stageLights.trussSlots) {
      if (slot.occupiedBy === fixture) {
        slot.occupiedBy = null;
        slot.marker.visible = true;
      }
    }
  }
  scene.remove(fixture.group);
  // Best-effort dispose. Skipping ShaderMaterial uniforms etc.; small leak
  // OK for a previz tool.
  fixture.group.traverse?.((obj) => {
    obj.geometry?.dispose?.();
    if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose?.());
    else obj.material?.dispose?.();
  });
  const i = fixtures.indexOf(fixture);
  if (i >= 0) fixtures.splice(i, 1);
  fixtureCountEl.textContent = String(fixtures.length);
  if (selected === fixture) {
    selected = null;
    outliner?.setSelection(null);
  }
  outliner?.refresh();
  sendPatchToServer();
}

// Find the first free DMX address range in `universe` that can hold
// `channelCount` consecutive channels. Returns -1 if none fits.
function nextFreeAddress(channelCount, universe = 0) {
  const used = new Array(513).fill(false);
  for (const f of fixtures) {
    if (f.patch.universe !== universe) continue;
    for (let i = 0; i < f.profile.channelCount; i++) {
      const addr = f.patch.startAddress + i;
      if (addr >= 1 && addr <= 512) used[addr] = true;
    }
  }
  for (let start = 1; start + channelCount - 1 <= 512; start++) {
    let free = true;
    for (let i = 0; i < channelCount; i++) {
      if (used[start + i]) { free = false; break; }
    }
    if (free) return start;
  }
  return -1;
}

// Generate a fixture ID unique within the current fixtures array.
// Form: "<profile-prefix>_<n>", e.g. rockwedge_1, oppskbar_2.
function genFixtureId(profileName) {
  const base = profileName.split('_')[0];
  let n = 1;
  // Loop until we find a free slot — bounded by fixture count
  while (fixtures.some((f) => f.patch.fixtureId === `${base}_${n}`)) n++;
  return `${base}_${n}`;
}

// Build a sensible default patch entry for placing a fixture on the floor
// near the audience-facing edge of the stage.
function defaultDefForFloor(profile) {
  const def = {
    fixtureId: genFixtureId(profile.name),
    profile:   profile.name,
    universe:  0,
    startAddress: nextFreeAddress(profile.channelCount, 0),
    position:  [0, 0.25, 2.5],     // a bit in front of the audience-facing edge
    mount:     'floor',
  };
  // Type-specific extras
  if (profile.type === 'wedge' || profile.type === 'par' || !profile.type) {
    // Aim at stage center — buildWedge uses aim's XZ; buildPar uses full 3D.
    def.aim = [0, 4, 0];
  }
  if (profile.type === 'bar') {
    def.rotation = [0, 0, 0];
    def.length = 1.0;
    // Floor bars default to vertical — the typical "pixel bar uplight"
    // use case. Truss bars stay horizontal (lying along the truss).
    def.orientation = 'vertical';
  }
  return def;
}

function defaultDefForTrussSlot(profile, slot) {
  const def = {
    fixtureId: genFixtureId(profile.name),
    profile:   profile.name,
    universe:  0,
    startAddress: nextFreeAddress(profile.channelCount, 0),
    position:  [slot.x, slot.y, slot.z],
    mount:     'truss',
  };
  if (profile.type === 'par' || !profile.type) {
    // Aim slightly downward toward the stage area (z = -3 to 0)
    def.aim = [slot.x * 0.5, 0, slot.z + 1.5];
  }
  if (profile.type === 'wedge') {
    def.aim = [slot.x * 0.5, 0, slot.z + 1.5];
  }
  if (profile.type === 'bar') {
    def.rotation = [0, 0, 0];
    def.length = 1.2;
    def.orientation = 'horizontal';
  }
  return def;
}

// ─── Picker-flow helpers ──────────────────────────────────────────────────

async function handleSlotClick(slot) {
  if (slot.occupiedBy) return;  // shouldn't happen — marker is hidden
  const profile = await pickFixture({ title: 'Place Fixture on Truss' });
  if (!profile) return;
  profileCache.set(profile.name, profile);
  const def = defaultDefForTrussSlot(profile, slot);
  if (def.startAddress < 0) {
    alert('No free DMX addresses on universe 0');
    return;
  }
  addFixture(def);
}

// Snap a raycast hit's Y to the top of any walkable obstacle whose XZ
// footprint contains the point. Otherwise return the raycast Y unchanged.
// For default stage this prevents pasting on the side of the deck from
// leaving the fixture embedded; for OBJ model scenes (no walkables) the
// raycast Y is the ground-truth surface so we leave it alone.
function snapPlacementY(worldPoint) {
  if (activeSceneType !== 'default') return worldPoint.y;
  let y = worldPoint.y;
  for (const o of stageLights.obstacles || []) {
    if (!o.walkable) continue;
    if (Math.abs(worldPoint.x - o.cx) <= o.hw &&
        Math.abs(worldPoint.z - o.cz) <= o.hd) {
      if (o.yTop > y) y = o.yTop;
    }
  }
  return y;
}

// Build the list of meshes the placement raycaster should hit-test against
// for *this* placement gesture. Includes whichever scene is active plus any
// extra models. The slot-marker filter happens inside dragging.js.
function getPlacementTargets() {
  const targets = [];
  if (activeSceneType === 'default') {
    targets.push(stageLights.stageGroup);
  } else if (activeSceneModel) {
    targets.push(activeSceneModel.group);
  }
  for (const m of extraModels) targets.push(m.group);
  return targets;
}

async function doAddFloor() {
  const profile = await pickFixture({ title: 'Add Floor Fixture' });
  if (!profile) return;
  profileCache.set(profile.name, profile);
  const def = defaultDefForFloor(profile);
  if (def.startAddress < 0) {
    alert('No free DMX addresses on universe 0');
    return;
  }
  if (!dragging) return;
  dragging.startPlacement({
    targets: getPlacementTargets(),
    onPlace: (worldPoint) => {
      // Build the fixture, then snap its root to the click point. Run a
      // single collision-resolution pass for XZ overlaps; snap Y up to
      // any walkable obstacle at that XZ so e.g. clicking the side of the
      // deck lands the fixture on the deck top rather than embedded.
      const py = snapPlacementY(worldPoint);
      def.position = [worldPoint.x, py, worldPoint.z];
      const fixture = addFixture(def);
      if (!fixture) return;
      fixture.group.position.set(worldPoint.x, py, worldPoint.z);
      const resolved = dragging.resolvePlacementXZ(fixture, worldPoint.x, worldPoint.z);
      fixture.group.position.x = resolved.x;
      fixture.group.position.z = resolved.z;
    },
    onCancel: () => { /* nothing extra to clean up */ },
  });
}

async function doAddTruss() {
  const slot = stageLights.trussSlots?.find((s) => !s.occupiedBy);
  if (!slot) { alert('All truss slots are occupied'); return; }
  return handleSlotClick(slot);
}

// ─── Scene and extra-model state ──────────────────────────────────────────
//
// The "scene" is exactly one of:
//   - 'default'  → the procedural stage in stage.js
//   - a model id → an OBJ model (replaces the stage)
// Plus an independent list of "extra models" that are stacked on top of
// whichever scene is active.

let activeSceneType = 'default';     // 'default' | 'model'
let activeSceneModel = null;          // { id, group } when activeSceneType === 'model'

// dragObstacles is the array setupDragging captured — we mutate IN PLACE so
// the drag system sees obstacle changes when the scene switches.
const dragObstacles = [...(stageLights.obstacles || [])];

async function setScene(choice) {
  // Tear down the previous scene
  if (activeSceneModel) {
    scene.remove(activeSceneModel.group);
    activeSceneModel.group.traverse?.((obj) => {
      obj.geometry?.dispose?.();
      if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose?.());
      else obj.material?.dispose?.();
    });
    activeSceneModel = null;
  }
  if (choice === 'default') {
    stageLights.stageGroup.visible = true;
    dragObstacles.length = 0;
    dragObstacles.push(...(stageLights.obstacles || []));
    activeSceneType = 'default';
  } else {
    // choice is a model descriptor returned by pickModel / listModels.
    stageLights.stageGroup.visible = false;
    dragObstacles.length = 0;                     // no known collision for an OBJ scene
    activeSceneType = 'model';
    try {
      const group = await loadModel(choice);
      group.position.set(0, 0, 0);
      scene.add(group);
      activeSceneModel = { id: choice.id, group };
    } catch (err) {
      console.error('scene model load failed', err);
      alert(`Could not load scene model:\n${err.message}`);
      // Fall back to default so we don't leave the user with nothing
      stageLights.stageGroup.visible = true;
      dragObstacles.push(...(stageLights.obstacles || []));
      activeSceneType = 'default';
    }
  }
}

async function doPickScene() {
  const choice = await pickScene();
  if (!choice) return;
  await setScene(choice);
}

// Extra models — independent of the scene, additive.
const extraModels = [];

async function doAddModel() {
  const choice = await pickModel({ title: 'Add Model' });
  if (!choice) return;
  let group;
  try {
    group = await loadModel(choice);
  } catch (err) {
    console.error('model load failed', err);
    alert(`Could not load model:\n${err.message}`);
    return;
  }
  group.position.set(0, 0, 0);
  scene.add(group);
  extraModels.push({ id: choice.id, group });
}

// Remove a single extra model (e.g. via Delete while it's selected).
function removeExtraModel(model) {
  const i = extraModels.indexOf(model);
  if (i >= 0) extraModels.splice(i, 1);
  scene.remove(model.group);
  model.group.traverse?.((obj) => {
    obj.geometry?.dispose?.();
    if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose?.());
    else obj.material?.dispose?.();
  });
  if (selectedModel === model) handleSelectModel(null);
}

// Selection highlight — a glowing ring on the floor that sits directly under
// the selected fixture, plus a thin vertical line so truss-mounted fixtures
// are easy to spot at a glance. Updated each frame from `selected`.
let selected = null;
const selectionRing = new THREE.Mesh(
  new THREE.RingGeometry(0.36, 0.46, 48),
  new THREE.MeshBasicMaterial({
    color: 0xffcc33, transparent: true, opacity: 0.9,
    side: THREE.DoubleSide, toneMapped: false, depthWrite: false,
  }),
);
selectionRing.rotation.x = -Math.PI / 2;
selectionRing.position.y = 0.012;
selectionRing.visible = false;
selectionRing.raycast = () => {};
scene.add(selectionRing);

const selectionStem = new THREE.Mesh(
  new THREE.CylinderGeometry(0.012, 0.012, 1, 8),
  new THREE.MeshBasicMaterial({
    color: 0xffcc33, transparent: true, opacity: 0.6,
    toneMapped: false, depthWrite: false,
  }),
);
selectionStem.visible = false;
selectionStem.raycast = () => {};
scene.add(selectionStem);

// Selection is owned here so the sidebar and 3D view stay in sync. Click on
// the same fixture toggles it off; null means "clear selection".
let outliner = null;
// Drag controller handle (placement / collision helpers exposed here).
let dragging = null;
function handleSelect(fixture) {
  // Selecting a fixture (or clearing on an empty-space click) always drops any
  // model selection — the two are mutually exclusive.
  if (selectedModel) handleSelectModel(null);
  if (!fixture) {
    selected = null;
  } else if (selected === fixture) {
    selected = null;
  } else {
    selected = fixture;
  }
  outliner?.setSelection(selected);
}

// Selected extra model (independent of fixture selection). Highlighted with a
// wireframe bounding box so the click target is obvious; the box follows the
// model as it's dragged.
let selectedModel = null;
const modelSelectionBox = new THREE.BoxHelper(undefined, 0xffcc33);
modelSelectionBox.material.toneMapped = false;
modelSelectionBox.material.transparent = true;
modelSelectionBox.material.opacity = 0.9;
modelSelectionBox.visible = false;
modelSelectionBox.raycast = () => {};
scene.add(modelSelectionBox);

function handleSelectModel(model) {
  // Toggle off if re-clicking the same model; null clears.
  selectedModel = (!model || model === selectedModel) ? null : model;
  if (selectedModel) {
    selected = null;                         // exclusive with fixture selection
    outliner?.setSelection(null);
    modelSelectionBox.setFromObject(selectedModel.group);
    modelSelectionBox.visible = true;
  } else {
    modelSelectionBox.visible = false;
  }
}

// Snapshot of the scene state captured right after initial build, used by
// "New Scene" to revert without re-fetching patch.json.
let initialState = null;

// Update HUD slider DOM to match the current lighting/scene state. Called
// after Open or New Scene so the panel doesn't show stale values.
function refreshLightingUi() {
  const set = (id, val, fmt) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
    if (fmt) {
      const v = document.getElementById(id + '-v');
      if (v) v.textContent = fmt(parseFloat(val));
    }
  };
  set('amb-int', stageLights.ambient.intensity, (n) => n.toFixed(2));
  document.getElementById('amb-col').value = '#' + stageLights.ambient.color.getHexString();
  set('key-int', stageLights.key.intensity, (n) => n.toFixed(2));
  document.getElementById('key-col').value = '#' + stageLights.key.color.getHexString();
  document.getElementById('bg-col').value = '#' + scene.background.getHexString();
  set('fog', scene.fog.density, (n) => n.toFixed(3));
  set('exp', renderer.toneMappingExposure, (n) => n.toFixed(2));
}

loadPatchAndBuild()
  .then(() => {
    // Floor-mounted fixtures are draggable; truss fixtures are fixed but
    // still clickable for selection. Truss slots open the fixture picker
    // when clicked.
    dragging = setupDragging({
      renderer, camera, controls, fixtures,
      obstacles: dragObstacles,                 // mutated in place by setScene
      slots:     stageLights.trussSlots || [],
      models:    extraModels,                   // mutated in place by doAddModel
      onSelect:  handleSelect,
      onSlotClick: handleSlotClick,
      onSelectModel: handleSelectModel,
    });

    // Outliner panel — same handleSelect ensures sidebar clicks update the
    // 3D highlight ring and vice versa.
    outliner = createOutliner({
      fixtures,
      onSelect: handleSelect,
      onOrient: (f, orientation) => setBarOrientation(f, orientation),
      onYaw: (f, yawRad) => setFixtureYaw(f, yawRad),
    });

    // Snapshot the just-built scene for use by "New Scene" / Reset.
    initialState = serializeScene(sceneCtx());
  })
  .catch((err) => {
    console.error('patch/profile load failed', err);
    wsStatus.textContent = 'patch failed';
    wsStatus.className = 'err';
  });

// ───────────────────────────────────────────────────────────────────────────
// Ctrl + wheel = yaw the currently-selected fixture, but only while the
// pointer is over its body. Outside the body, the wheel falls through to
// OrbitControls zoom as usual.
//
// Listener notes: OrbitControls registers its own wheel handler on the same
// canvas, ahead of this one. To intercept the event BEFORE OrbitControls
// zooms, we listen in the capture phase and call stopImmediatePropagation —
// preventDefault alone isn't enough because both listeners are on the same
// element and their order is "registration order in the bubble phase".
// ───────────────────────────────────────────────────────────────────────────
const YAW_WHEEL_STEP_RAD = (5 * Math.PI) / 180;
const wheelRaycaster = new THREE.Raycaster();
const wheelPointer = new THREE.Vector2();
renderer.domElement.addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !selected) return;
  const rect = renderer.domElement.getBoundingClientRect();
  wheelPointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  wheelPointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  wheelRaycaster.setFromCamera(wheelPointer, camera);
  const hits = wheelRaycaster.intersectObject(selected.group, true);
  if (hits.length === 0) return;          // not hovering the selected fixture
  e.preventDefault();                     // browser ctrl-zoom
  e.stopImmediatePropagation();           // OrbitControls' wheel handler
  const dir = e.deltaY > 0 ? 1 : -1;
  const newYaw = (selected.yaw || 0) + dir * YAW_WHEEL_STEP_RAD;
  setFixtureYaw(selected, newYaw);
  outliner?.refresh();
}, { passive: false, capture: true });

// ───────────────────────────────────────────────────────────────────────────
// Menu bar wiring — File > New / Open / Save
// ───────────────────────────────────────────────────────────────────────────
const fileMenu = document.getElementById('menu-file');

fileMenu.querySelector('.menu-button').addEventListener('click', (e) => {
  e.stopPropagation();
  // Close any other open menus, then toggle this one
  for (const m of document.querySelectorAll('#menubar .menu')) {
    if (m !== fileMenu) m.classList.remove('open');
  }
  fileMenu.classList.toggle('open');
});

// Click anywhere else closes the menu
document.addEventListener('click', () => fileMenu.classList.remove('open'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') fileMenu.classList.remove('open');
});

// Remove all extra (additive) models from the scene. Used by applyScene
// before rebuilding from a save file. The scene-model is handled by
// setScene() instead.
function removeAllExtraModels() {
  for (const m of extraModels) {
    scene.remove(m.group);
    m.group.traverse?.((obj) => {
      obj.geometry?.dispose?.();
      if (Array.isArray(obj.material)) obj.material.forEach((mat) => mat.dispose?.());
      else obj.material?.dispose?.();
    });
  }
  extraModels.length = 0;
}

// Re-import an extra model by id and apply its transform.
async function reAddExtraModelById(id, transform) {
  const res = await fetch('/models');
  const list = await res.json();
  const choice = list.find((m) => m.id === id);
  if (!choice) {
    console.warn(`model ${id} not found on server; skipping`);
    return null;
  }
  const group = await loadModel(choice);
  if (transform) {
    if (transform.position) group.position.fromArray(transform.position);
    if (transform.rotation) group.rotation.fromArray(transform.rotation);
    if (typeof transform.scale === 'number') group.scale.setScalar(transform.scale);
  }
  scene.add(group);
  extraModels.push({ id, group });
  return group;
}

// Apply a saved scene choice ('default' or a model id) on load.
async function applySceneChoice(choice) {
  if (choice === 'default' || !choice) {
    await setScene('default');
  } else {
    // choice is a model id string; we need the descriptor
    const res = await fetch('/models');
    const list = await res.json();
    const m = list.find((x) => x.id === choice);
    if (m) await setScene(m);
    else { console.warn(`scene model ${choice} not found; falling back to default`); await setScene('default'); }
  }
}

const sceneCtx = () => ({
  fixtures, stageLights, scene, renderer, camera, controls,
  addFixture, removeFixture, loadProfile,
  setBarOrientation, setFixtureYaw, refreshLightingUi,
  extraModels, removeAllExtraModels, reAddExtraModelById,
  get activeSceneModel() { return activeSceneModel; },
  getActiveSceneId: () => activeSceneType === 'default' ? 'default' : activeSceneModel?.id,
  applySceneChoice,
});

async function doNew() {
  if (fixtures.length > 0 && !confirm('New scene: clear all fixtures?')) return;
  currentFileHandle = null;   // a fresh scene is no longer tied to a saved file
  await applyScene(initialState || { version: 2, fixtures: [] }, sceneCtx());
}

// Handle to the file the scene is currently bound to (set by Save or Open).
// Subsequent saves overwrite this file in place. Null until the first save /
// open, or after New. Only used when the File System Access API is available.
let currentFileHandle = null;
let lastSaveName = 'lightviz-scene';

async function doSave() {
  const data = serializeScene(sceneCtx());
  if (supportsFsAccess()) {
    try {
      // First save (or after New) picks a location; later saves overwrite it.
      if (!currentFileHandle) {
        currentFileHandle = await pickSaveFileHandle({ suggestedName: lastSaveName + '.json' });
        if (!currentFileHandle) return;   // user cancelled
      }
      await writeJsonToHandle(currentFileHandle, data);
      lastSaveName = (currentFileHandle.name || lastSaveName).replace(/\.json$/i, '');
    } catch (err) {
      console.error('save failed', err);
      alert('Could not save scene file:\n' + err.message);
    }
    return;
  }
  // Fallback (Firefox/Safari): no in-place overwrite — download a new file.
  const name = await showSaveDialog({ defaultName: lastSaveName });
  if (!name) return;
  lastSaveName = name.replace(/\.json$/i, '');
  downloadJson(data, name);
}

async function doOpen() {
  try {
    if (supportsFsAccess()) {
      const res = await pickOpenFileHandle();
      if (!res) return;
      await applyScene(res.data, sceneCtx());
      currentFileHandle = res.handle;   // bind Save to the file we just opened
      lastSaveName = (res.handle.name || lastSaveName).replace(/\.json$/i, '');
      return;
    }
    const input = document.getElementById('open-file-input');
    const data = await pickJsonFile(input);
    if (!data) return;
    await applyScene(data, sceneCtx());
  } catch (err) {
    console.error('load failed', err);
    alert('Could not load scene file:\n' + err.message);
  }
}

for (const btn of fileMenu.querySelectorAll('.dropdown button[data-action]')) {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    fileMenu.classList.remove('open');
    const action = btn.dataset.action;
    if (action === 'new') doNew();
    else if (action === 'save') doSave();
    else if (action === 'open') doOpen();
    else if (action === 'set-scene') doPickScene();
  });
}

// ─── Add menu ──────────────────────────────────────────────────────────────
const addMenu = document.getElementById('menu-add');
addMenu.querySelector('.menu-button').addEventListener('click', (e) => {
  e.stopPropagation();
  for (const m of document.querySelectorAll('#menubar .menu')) {
    if (m !== addMenu) m.classList.remove('open');
  }
  addMenu.classList.toggle('open');
});
document.addEventListener('click', () => addMenu.classList.remove('open'));
for (const btn of addMenu.querySelectorAll('.dropdown button[data-action]')) {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    addMenu.classList.remove('open');
    const action = btn.dataset.action;
    if (action === 'add-floor') doAddFloor();
    else if (action === 'add-truss') doAddTruss();
    else if (action === 'add-model') doAddModel();
  });
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────
// Delete / Backspace: remove the currently-selected fixture (unless a text
// input is focused). 'a': open Add Floor Fixture.
window.addEventListener('keydown', (e) => {
  const active = document.activeElement;
  const inInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
  if (inInput) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
    e.preventDefault();
    removeFixture(selected);
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedModel) {
    e.preventDefault();
    removeExtraModel(selectedModel);
  } else if (e.key === 'a' && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    doAddFloor();
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && selected) {
    e.preventDefault();
    copyFixture(selected);
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v' && clipboard) {
    e.preventDefault();
    pasteFixtureOffset();
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd' && selected) {
    // Ctrl/Cmd+D = duplicate (familiar from many editors)
    e.preventDefault();
    copyFixture(selected);
    pasteFixtureOffset();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Clipboard + copy / paste / duplicate
// ───────────────────────────────────────────────────────────────────────────
let clipboard = null;    // { profile, mount, aim?, rotation?, length?, yaw, orientation? }

function copyFixture(fixture) {
  clipboard = {
    profile: fixture.profile.name,
    mount: fixture.mount,
    aim: fixture.patch.aim,
    rotation: fixture.patch.rotation,
    length: fixture.patch.length,
    yaw: fixture.yaw || 0,
    orientation: fixture.orientation,
    srcPosition: [fixture.group.position.x, fixture.group.position.y, fixture.group.position.z],
    // Inherit the source's DMX universe + address so the pasted fixture
    // mirrors the source's lighting behaviour out of the box. Multiple
    // fixtures sharing one address is legal DMX (the patch model doesn't
    // require uniqueness) and matches how rigs often group identical
    // fixtures on a single channel.
    universe: fixture.patch.universe ?? 0,
    startAddress: fixture.patch.startAddress,
  };
}

function makeDefFromClipboard(worldPoint) {
  if (!clipboard) return null;
  const profile = profileCache.get(clipboard.profile);
  if (!profile) {
    console.warn('paste: profile not loaded', clipboard.profile);
    return null;
  }
  const def = {
    fixtureId: genFixtureId(profile.name),
    profile: clipboard.profile,
    universe: clipboard.universe ?? 0,
    startAddress: clipboard.startAddress ?? nextFreeAddress(profile.channelCount, 0),
    position: [worldPoint.x, worldPoint.y, worldPoint.z],
    mount: clipboard.mount,
  };
  if (clipboard.aim)        def.aim = clipboard.aim;
  if (clipboard.rotation)   def.rotation = clipboard.rotation;
  if (clipboard.length !== undefined) def.length = clipboard.length;
  if (clipboard.orientation) def.orientation = clipboard.orientation;
  return def;
}

function pasteFixtureAt(worldPoint) {
  const def = makeDefFromClipboard(worldPoint);
  if (!def) return null;
  if (def.startAddress < 0) {
    alert('No free DMX addresses on universe 0');
    return null;
  }
  const fixture = addFixture(def);
  if (!fixture) return null;
  const py = snapPlacementY(worldPoint);
  fixture.group.position.set(worldPoint.x, py, worldPoint.z);
  if (clipboard.yaw) setFixtureYaw(fixture, clipboard.yaw);
  if (dragging) {
    const r = dragging.resolvePlacementXZ(fixture, worldPoint.x, worldPoint.z);
    fixture.group.position.x = r.x;
    fixture.group.position.z = r.z;
  }
  return fixture;
}

// Ctrl/Cmd+V (no specific point): paste at source position + 0.5 m east. If
// the source is gone (e.g. it was deleted after copy), still works since we
// captured the position in the clipboard at copy time.
function pasteFixtureOffset() {
  if (!clipboard) return;
  const p = clipboard.srcPosition || [0, 0, 0];
  const offset = 0.5;
  pasteFixtureAt({ x: p[0] + offset, y: p[1], z: p[2] });
}

// ───────────────────────────────────────────────────────────────────────────
// Right-click context menu
// ───────────────────────────────────────────────────────────────────────────
const ctxMenu = document.getElementById('context-menu');
const ctxRaycaster = new THREE.Raycaster();
let ctxTargetFixture = null;
let ctxTargetWorldPoint = null;

function getNdcFromEvent(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
    y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
  };
}

function raycastFixtureAt(e) {
  if (fixtures.length === 0) return null;
  const ndc = getNdcFromEvent(e);
  ctxRaycaster.setFromCamera(ndc, camera);
  const roots = fixtures.map((f) => f.group);
  const hits = ctxRaycaster.intersectObjects(roots, true);
  if (hits.length === 0) return null;
  let obj = hits[0].object;
  while (obj && !roots.includes(obj)) obj = obj.parent;
  return obj ? fixtures.find((f) => f.group === obj) || null : null;
}

function raycastWorldAt(e) {
  const ndc = getNdcFromEvent(e);
  ctxRaycaster.setFromCamera(ndc, camera);
  const targets = getPlacementTargets();
  const hits = ctxRaycaster.intersectObjects(targets, true);
  for (const h of hits) {
    if (h.object.userData?.isSlotMarker) continue;
    return h.point;
  }
  return null;
}

function showContextMenu(x, y) {
  ctxMenu.classList.add('open');
  // Position; nudge left/up if it would overflow the viewport.
  const w = ctxMenu.offsetWidth;
  const h = ctxMenu.offsetHeight;
  const px = Math.min(x, window.innerWidth - w - 4);
  const py = Math.min(y, window.innerHeight - h - 4);
  ctxMenu.style.left = px + 'px';
  ctxMenu.style.top = py + 'px';

  // Enable/disable items based on context
  const setEnabled = (action, on) => {
    const btn = ctxMenu.querySelector(`button[data-action="${action}"]`);
    if (btn) btn.disabled = !on;
  };
  setEnabled('copy',      !!ctxTargetFixture);
  setEnabled('duplicate', !!ctxTargetFixture);
  setEnabled('delete',    !!ctxTargetFixture);
  setEnabled('paste',     !!clipboard && !!ctxTargetWorldPoint);
  // "Add Fixture Here" only when right-clicking empty surface (no fixture
  // under cursor) and we have a valid surface hit to place onto.
  setEnabled('add-here',  !ctxTargetFixture && !!ctxTargetWorldPoint);
}

function hideContextMenu() {
  ctxMenu.classList.remove('open');
  ctxTargetFixture = null;
  ctxTargetWorldPoint = null;
}

renderer.domElement.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  ctxTargetFixture = raycastFixtureAt(e);
  ctxTargetWorldPoint = raycastWorldAt(e);
  // Right-click also selects the fixture so it's obvious what we're acting on
  if (ctxTargetFixture) handleSelect(ctxTargetFixture);
  showContextMenu(e.clientX, e.clientY);
});

document.addEventListener('click', () => hideContextMenu());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ctxMenu.classList.contains('open')) {
    e.preventDefault();
    hideContextMenu();
  }
});

ctxMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || btn.disabled) return;
  e.stopPropagation();
  const action = btn.dataset.action;
  const fx = ctxTargetFixture;
  const wp = ctxTargetWorldPoint;
  hideContextMenu();
  if (action === 'copy' && fx) {
    copyFixture(fx);
  } else if (action === 'duplicate' && fx) {
    copyFixture(fx);
    pasteFixtureAt({
      x: fx.group.position.x + 0.5,
      y: fx.group.position.y,
      z: fx.group.position.z,
    });
  } else if (action === 'paste' && wp) {
    pasteFixtureAt(wp);
  } else if (action === 'add-here' && wp) {
    addFixtureAt(wp);
  } else if (action === 'delete' && fx) {
    removeFixture(fx);
  }
});

// Open the fixture picker, then place at the given world point. Same code
// path as doAddFloor's placement-mode click handler — just bypasses
// placement mode since the user already chose the point via right-click.
async function addFixtureAt(worldPoint) {
  const profile = await pickFixture({ title: 'Add Fixture Here' });
  if (!profile) return;
  profileCache.set(profile.name, profile);
  const def = defaultDefForFloor(profile);
  if (def.startAddress < 0) {
    alert('No free DMX addresses on universe 0');
    return;
  }
  const py = snapPlacementY(worldPoint);
  def.position = [worldPoint.x, py, worldPoint.z];
  const fixture = addFixture(def);
  if (!fixture) return;
  fixture.group.position.set(worldPoint.x, py, worldPoint.z);
  if (dragging) {
    const r = dragging.resolvePlacementXZ(fixture, worldPoint.x, worldPoint.z);
    fixture.group.position.x = r.x;
    fixture.group.position.z = r.z;
  }
}

// Cmd/Ctrl + S / O shortcuts
window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  const k = e.key.toLowerCase();
  if (k === 's') { e.preventDefault(); doSave(); }
  else if (k === 'o') { e.preventDefault(); doOpen(); }
});

// ───────────────────────────────────────────────────────────────────────────
// DMX websocket
// ───────────────────────────────────────────────────────────────────────────
const dmx = connectDmx({
  url: `ws://${location.hostname}:7777`,
  onStatus: (state) => {
    wsStatus.textContent = state;
    wsStatus.className = state === 'open' ? 'ok' : state === 'connecting' ? 'warn' : 'err';
  },
  onUniverses: (ids) => {
    universeList.textContent = ids.length ? ids.join(', ') : '—';
  },
  onOpen: () => sendPatchToServer(),
});

// Push the current patch to the server so its synth knows which channels
// belong to which profile. Throttled isn't needed — we only call this on
// open / add / remove and the payload is tiny.
function sendPatchToServer() {
  sendDmxMessage(dmx, {
    type: 'patch',
    fixtures: fixtures.map((f) => ({
      universe: f.patch.universe ?? 0,
      startAddress: f.patch.startAddress,
      profile: f.profile.name,
    })),
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Render loop
// ───────────────────────────────────────────────────────────────────────────
let lastT = performance.now();
let frameAcc = 0;
let frameCount = 0;

function tick() {
  const now = performance.now();
  const dt = (now - lastT) / 1000;
  lastT = now;
  frameAcc += dt;
  frameCount++;
  if (frameAcc >= 0.5) {
    fpsEl.textContent = (frameCount / frameAcc).toFixed(0);
    frameAcc = 0;
    frameCount = 0;
  }

  // Pull DMX → fixture params each frame
  for (const fixture of fixtures) {
    const params = resolveDmx(dmx, fixture.patch, fixture.profile);
    updateFixture(fixture, params, now / 1000);
  }

  // Selection indicator — the ring sits on whichever surface the fixture is
  // currently standing on (floor / deck / riser top). For truss-mounted
  // fixtures, the ring stays at world floor and a thin stem reaches up to
  // the fixture body.
  if (selected) {
    const x = selected.group.position.x;
    const z = selected.group.position.z;
    selectionRing.visible = true;
    const pulse = 0.85 + 0.15 * Math.sin(now / 200);
    selectionRing.material.opacity = pulse;
    if (selected.mount === 'truss') {
      selectionRing.position.set(x, 0.012, z);
      const bodyY = selected.patch.position?.[1] ?? 0;
      selectionStem.visible = true;
      selectionStem.position.set(x, bodyY / 2, z);
      selectionStem.scale.y = bodyY;
    } else {
      // Floor-mounted: group.position.y tracks the current surface
      // (0 = floor, 0.2 = deck top, 0.6 = riser top).
      const surfaceY = selected.group.position.y;
      selectionRing.position.set(x, surfaceY + 0.012, z);
      selectionStem.visible = false;
    }
  } else {
    selectionRing.visible = false;
    selectionStem.visible = false;
  }

  // Keep the model highlight box glued to the selected model as it's dragged.
  if (selectedModel) modelSelectionBox.update();

  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
