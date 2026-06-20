import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

// Some glTF scenes ship over-bright emissive panels that cross the global
// bloom threshold and glow distractingly — e.g. the club model's back-wall
// video screen (material "SADASD", a full-white emissive 8.7×6.2 m panel).
// The single global bloom pass can't selectively skip an object, so instead we
// clamp these materials' emissive just below the bloom threshold (~0.6): the
// panel still reads as a screen but no longer blooms. Match is by glTF
// material name; add names here to tame other offenders.
const NO_BLOOM_MATERIALS = new Set(['SADASD']);   // club back-wall screen
const TAMED_EMISSIVE = 0.45;                       // below the bloom threshold

// Load a scene/model descriptor (as returned by listModels) and return the
// resulting THREE.Group with materials applied. Supports two formats:
//   - glTF (.glb/.gltf) — preferred; preserves PBR materials (metal, glass,
//     emission) and embeds textures, so it matches Blender far more closely.
//   - OBJ (.obj + optional .mtl) — legacy; flat Phong materials only.
export async function loadModel(model) {
  const group = model.gltf ? await loadGLTF(model) : await loadOBJ(model);

  // Tag the group so callers (e.g. the placement raycaster) can recognise
  // its meshes as "scene geometry" — used for surface-placement raycasting,
  // but NOT for fixture clicking (the fixture-pick path only looks at
  // fixture roots, so OBJ meshes are invisible to it).
  group.userData.isSceneGeometry = true;
  group.traverse?.((obj) => {
    if (!obj.isMesh) return;
    obj.userData.isSceneGeometry = true;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (m && NO_BLOOM_MATERIALS.has(m.name)) m.emissiveIntensity = TAMED_EMISSIVE;
    }
  });

  return group;
}

// Shared Draco decoder — pulls the WASM decoder served from /draco/ (copied
// from three's bundled libs). Harmless for uncompressed glTF; only invoked
// when the file actually carries Draco-compressed geometry.
let dracoLoader = null;
function getDracoLoader() {
  if (!dracoLoader) {
    dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath('/draco/');
  }
  return dracoLoader;
}

async function loadGLTF({ id, gltf, root }) {
  // Root-level files load from /models/<file>; folder models from /models/<dir>/.
  const base = root ? '/models/' : `/models/${encodeURIComponent(id)}/`;
  const loader = new GLTFLoader();
  loader.setPath(base);
  loader.setDRACOLoader(getDracoLoader());
  const result = await loader.loadAsync(gltf);
  return result.scene;
}

// The MTLLoader resolves texture paths relative to its `path` setting, so we
// configure both loaders with the same base. OBJ + MTL load sequentially —
// not parallel — because the OBJLoader needs the parsed MaterialCreator
// before it can attach materials to the geometry.
async function loadOBJ({ id, obj, mtl }) {
  const base = `/models/${encodeURIComponent(id)}/`;

  let materials = null;
  if (mtl) {
    const mtlLoader = new MTLLoader();
    mtlLoader.setPath(base);
    materials = await new Promise((resolve, reject) => {
      mtlLoader.load(mtl, resolve, undefined, reject);
    });
    materials.preload();
  }

  const objLoader = new OBJLoader();
  objLoader.setPath(base);
  if (materials) objLoader.setMaterials(materials);

  return new Promise((resolve, reject) => {
    objLoader.load(obj, resolve, undefined, reject);
  });
}

// Fetch the list of available model directories from the server.
export async function listModels() {
  const res = await fetch('/models');
  if (!res.ok) throw new Error(`models list failed: ${res.status}`);
  return res.json();
}

// Generic picker that reuses the fixture-picker modal element. Each item:
//   { name, meta, value }  — `value` is what's resolved on confirm.
// Returns the chosen value, or null if cancelled.
function showPicker({ title, confirmLabel = 'Place', items }) {
  const backdrop = document.getElementById('picker-modal');
  const titleEl = document.getElementById('picker-modal-title');
  const list = document.getElementById('picker-modal-list');
  const cancelBtn = document.getElementById('picker-modal-cancel');
  const confirmBtn = document.getElementById('picker-modal-confirm');

  titleEl.textContent = title;
  list.innerHTML = '';

  if (items.length === 0) {
    list.innerHTML = '<div style="padding:16px;color:#788;text-align:center">Nothing available.</div>';
  }

  let selected = null;
  let finalize;

  for (const it of items) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'picker-item';
    item.innerHTML = `
      <div class="name">${it.name}</div>
      <div class="meta">${it.meta || ''}</div>
    `;
    item.addEventListener('click', () => {
      selected = it.value;
      for (const el of list.querySelectorAll('.picker-item')) {
        el.classList.toggle('selected', el === item);
      }
      confirmBtn.disabled = false;
    });
    item.addEventListener('dblclick', () => { selected = it.value; finalize?.(); });
    list.appendChild(item);
  }

  confirmBtn.disabled = true;
  confirmBtn.textContent = confirmLabel;
  backdrop.classList.add('open');

  return new Promise((resolve) => {
    let settled = false;
    const close = (result) => {
      if (settled) return;
      settled = true;
      backdrop.classList.remove('open');
      confirmBtn.textContent = 'Place';
      cancelBtn.removeEventListener('click', onCancel);
      confirmBtn.removeEventListener('click', onConfirm);
      document.removeEventListener('keydown', onKey, true);
      backdrop.removeEventListener('click', onBackdrop);
      resolve(result);
    };
    finalize = () => { if (selected !== null) close(selected); };
    const onConfirm = () => finalize();
    const onCancel = () => close(null);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter' && selected !== null) { e.preventDefault(); finalize(); }
    };
    const onBackdrop = (e) => { if (e.target === backdrop) close(null); };

    cancelBtn.addEventListener('click', onCancel);
    confirmBtn.addEventListener('click', onConfirm);
    document.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('click', onBackdrop);
  });
}

// Scene picker — "Default Stage" + each available OBJ model.
// Returns 'default' string, a model descriptor, or null.
export async function pickScene() {
  const models = await listModels();
  return showPicker({
    title: 'Choose Scene',
    confirmLabel: 'Set Scene',
    items: [
      { name: 'Default Stage', meta: 'Procedural club rig (deck, truss, etc.)', value: 'default' },
      ...models.map((m) => ({
        name: m.name,
        meta: modelMeta(m),
        value: m,
      })),
    ],
  });
}

// Model picker — used by "Add > Model…" for extra (additive) models.
export async function pickModel({ title = 'Add Model' } = {}) {
  const models = await listModels();
  return showPicker({
    title,
    confirmLabel: 'Import',
    items: models.map((m) => ({
      name: m.name,
      meta: modelMeta(m),
      value: m,
    })),
  });
}

// One-line description for a model descriptor in the picker list.
function modelMeta(m) {
  if (m.gltf) return m.gltf + ' (glTF — PBR materials)';
  return m.obj + (m.mtl ? ' + ' + m.mtl : ' (no .mtl)');
}
