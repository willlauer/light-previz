import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

// Load a model from the server's /models/<dirId>/ directory. Returns the
// resulting THREE.Group with materials applied.
//
// The MTLLoader resolves texture paths relative to its `path` setting, so we
// configure both loaders with the same base. OBJ + MTL load sequentially —
// not parallel — because the OBJLoader needs the parsed MaterialCreator
// before it can attach materials to the geometry.
export async function loadModel({ id, obj, mtl }) {
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

  const group = await new Promise((resolve, reject) => {
    objLoader.load(obj, resolve, undefined, reject);
  });

  // Tag the group so callers (e.g. the placement raycaster) can recognise
  // its meshes as "scene geometry" — used for surface-placement raycasting,
  // but NOT for fixture clicking (the fixture-pick path only looks at
  // fixture roots, so OBJ meshes are invisible to it).
  group.userData.isSceneGeometry = true;
  group.traverse?.((obj) => {
    if (obj.isMesh) obj.userData.isSceneGeometry = true;
  });

  return group;
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
        meta: m.obj + (m.mtl ? ' + ' + m.mtl : ' (no .mtl)'),
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
      meta: m.obj + (m.mtl ? ' + ' + m.mtl : ' (no .mtl)'),
      value: m,
    })),
  });
}
