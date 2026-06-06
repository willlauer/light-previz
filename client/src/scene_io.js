// Save / load scene state to JSON.
//
// v2 layout: fixtures are stored as full definitions (since the patch is
// dynamic and starts empty), each with a `def` (immutable spec passed to
// createFixture) and a `state` (mutable runtime: current position, yaw,
// orientation). On load we clear all live fixtures and rebuild from defs,
// then apply each state on top.

const VERSION = 2;

export function serializeScene({ fixtures, extraModels = [], getActiveSceneId, stageLights, scene, renderer, camera, controls, activeSceneModel }) {
  return {
    version: VERSION,
    savedAt: new Date().toISOString(),
    sceneChoice: getActiveSceneId ? getActiveSceneId() : 'default',
    sceneModelTransform: activeSceneModel ? {
      position: activeSceneModel.group.position.toArray(),
      rotation: [activeSceneModel.group.rotation.x, activeSceneModel.group.rotation.y, activeSceneModel.group.rotation.z],
      scale: activeSceneModel.group.scale.x,
    } : null,
    fixtures: fixtures.map((f) => ({
      def: f.patch,
      state: {
        x: f.group.position.x,
        y: f.group.position.y,
        z: f.group.position.z,
        yaw: f.yaw || 0,
        ...(f.kind === 'bar' ? { orientation: f.orientation } : {}),
      },
    })),
    extraModels: extraModels.map((m) => ({
      id: m.id,
      position: m.group.position.toArray(),
      rotation: [m.group.rotation.x, m.group.rotation.y, m.group.rotation.z],
      scale: m.group.scale.x,
    })),
    lighting: {
      ambientIntensity: stageLights.ambient.intensity,
      ambientColor:     '#' + stageLights.ambient.color.getHexString(),
      keyIntensity:     stageLights.key.intensity,
      keyColor:         '#' + stageLights.key.color.getHexString(),
      background:       '#' + scene.background.getHexString(),
      fogDensity:       scene.fog.density,
      exposure:         renderer.toneMappingExposure,
    },
    camera: {
      position: [camera.position.x, camera.position.y, camera.position.z],
      target:   [controls.target.x, controls.target.y, controls.target.z],
    },
  };
}

// Async because adding fixtures requires loading their profile JSON.
// Caller supplies the dynamic fixture ops it owns (addFixture / removeFixture
// / loadProfile / setBarOrientation / setFixtureYaw) plus references to
// scene state we mutate directly (lights, fog, camera, etc.).
export async function applyScene(data, ctx) {
  if (!data || typeof data.version !== 'number') {
    throw new Error('scene file is missing version');
  }
  if (data.version > VERSION) {
    throw new Error(`scene file is version ${data.version}, this build supports up to ${VERSION}`);
  }

  // Clear current fixtures (snapshot first since removeFixture mutates ctx.fixtures)
  for (const f of [...ctx.fixtures]) ctx.removeFixture(f);
  // Clear extra models; the scene-model gets handled by applySceneChoice
  ctx.removeAllExtraModels?.();

  // Restore the scene choice first so geometry obstacles update before
  // any fixtures are placed (which may need to know about deck climbing).
  await ctx.applySceneChoice?.(data.sceneChoice || 'default');

  // Rebuild from saved defs
  for (const item of data.fixtures || []) {
    let def, state;
    if (data.version === 1) {
      // v1 stored fixtures as keyed object of partial state — there was no
      // def. Skip: there's nothing to build without the original entry.
      continue;
    } else {
      def = item.def;
      state = item.state || {};
    }
    if (!def) continue;
    try {
      await ctx.loadProfile(def.profile);
    } catch (err) {
      console.warn(`skipping fixture ${def.fixtureId}: ${err.message}`);
      continue;
    }
    const fixture = ctx.addFixture(def);
    if (!fixture) continue;
    if (typeof state.x === 'number') fixture.group.position.x = state.x;
    if (typeof state.y === 'number') fixture.group.position.y = state.y;
    if (typeof state.z === 'number') fixture.group.position.z = state.z;
    if (state.orientation && fixture.kind === 'bar') {
      ctx.setBarOrientation(fixture, state.orientation);
    }
    if (typeof state.yaw === 'number') {
      ctx.setFixtureYaw(fixture, state.yaw);
    }
  }

  // Re-import extra models
  for (const m of data.extraModels || []) {
    try {
      await ctx.reAddExtraModelById?.(m.id, { position: m.position, rotation: m.rotation, scale: m.scale });
    } catch (err) {
      console.warn(`failed to restore extra model ${m.id}:`, err);
    }
  }

  const L = data.lighting;
  if (L) {
    if (typeof L.ambientIntensity === 'number') ctx.stageLights.ambient.intensity = L.ambientIntensity;
    if (L.ambientColor) ctx.stageLights.ambient.color.set(L.ambientColor);
    if (typeof L.keyIntensity === 'number') ctx.stageLights.key.intensity = L.keyIntensity;
    if (L.keyColor) ctx.stageLights.key.color.set(L.keyColor);
    if (L.background) { ctx.scene.background.set(L.background); ctx.scene.fog.color.set(L.background); }
    if (typeof L.fogDensity === 'number') ctx.scene.fog.density = L.fogDensity;
    if (typeof L.exposure === 'number') ctx.renderer.toneMappingExposure = L.exposure;
  }

  if (data.camera) {
    if (Array.isArray(data.camera.position) && data.camera.position.length === 3) {
      ctx.camera.position.fromArray(data.camera.position);
    }
    if (Array.isArray(data.camera.target) && data.camera.target.length === 3) {
      ctx.controls.target.fromArray(data.camera.target);
    }
    ctx.controls.update();
  }

  ctx.refreshLightingUi?.();
}

export function showSaveDialog({ defaultName = 'lightviz-scene' } = {}) {
  return new Promise((resolve) => {
    const backdrop = document.getElementById('save-modal');
    const input = document.getElementById('save-modal-name');
    const cancelBtn = document.getElementById('save-modal-cancel');
    const confirmBtn = document.getElementById('save-modal-confirm');

    input.value = defaultName;
    backdrop.classList.add('open');
    setTimeout(() => { input.focus(); input.select(); }, 0);

    let settled = false;
    const close = (result) => {
      if (settled) return;
      settled = true;
      backdrop.classList.remove('open');
      input.removeEventListener('keydown', onKey);
      backdrop.removeEventListener('click', onBackdropClick);
      cancelBtn.removeEventListener('click', onCancel);
      confirmBtn.removeEventListener('click', onConfirm);
      document.removeEventListener('keydown', onEsc, true);
      resolve(result);
    };
    const finalize = () => {
      const raw = (input.value || '').trim();
      if (!raw) return;
      const name = raw.toLowerCase().endsWith('.json') ? raw : raw + '.json';
      close(name);
    };
    const onConfirm = () => finalize();
    const onCancel = () => close(null);
    const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); finalize(); } };
    const onEsc = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } };
    const onBackdropClick = (e) => { if (e.target === backdrop) close(null); };

    input.addEventListener('keydown', onKey);
    cancelBtn.addEventListener('click', onCancel);
    confirmBtn.addEventListener('click', onConfirm);
    document.addEventListener('keydown', onEsc, true);
    backdrop.addEventListener('click', onBackdropClick);
  });
}

// ─── File System Access API ────────────────────────────────────────────────
// When available (Chromium-based browsers), we hold a FileSystemFileHandle to
// the saved/opened file so subsequent saves overwrite that same file in place
// rather than dumping a fresh download each time. Firefox/Safari lack the API,
// so callers fall back to showSaveDialog + downloadJson.

export function supportsFsAccess() {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

const JSON_PICKER_TYPES = [
  { description: 'Scene JSON', accept: { 'application/json': ['.json'] } },
];

// Prompt for a save location; returns a FileSystemFileHandle, or null if the
// user cancelled. The caller keeps the handle to overwrite the file later.
export async function pickSaveFileHandle({ suggestedName = 'lightviz-scene.json' } = {}) {
  try {
    return await window.showSaveFilePicker({ suggestedName, types: JSON_PICKER_TYPES });
  } catch (err) {
    if (err?.name === 'AbortError') return null;
    throw err;
  }
}

// Prompt to open a file; returns { handle, data } or null if cancelled. The
// handle is reused so a later Save overwrites the file that was opened.
export async function pickOpenFileHandle() {
  let handle;
  try {
    [handle] = await window.showOpenFilePicker({ types: JSON_PICKER_TYPES, multiple: false });
  } catch (err) {
    if (err?.name === 'AbortError') return null;
    throw err;
  }
  const text = await (await handle.getFile()).text();
  try {
    return { handle, data: JSON.parse(text) };
  } catch (e) {
    throw new Error('Not valid JSON: ' + e.message);
  }
}

// Overwrite an open file handle with `obj` serialized as pretty JSON.
export async function writeJsonToHandle(handle, obj) {
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(obj, null, 2));
  await writable.close();
}

export function downloadJson(obj, filename = 'lightviz-scene.json') {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function pickJsonFile(inputEl) {
  return new Promise((resolve, reject) => {
    const onChange = () => {
      inputEl.removeEventListener('change', onChange);
      const file = inputEl.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => {
        try { resolve(JSON.parse(reader.result)); }
        catch (e) { reject(new Error('Not valid JSON: ' + e.message)); }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
      inputEl.value = '';
    };
    inputEl.addEventListener('change', onChange);
    inputEl.click();
  });
}
