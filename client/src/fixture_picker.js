// Fixture picker modal — lists every available profile, grouped by type.
// Resolves with the chosen profile object (already loaded JSON), or null
// if the user cancelled.

const TYPE_LABEL = {
  par: 'Pars',
  bar: 'Bars',
  wedge: 'Wedges',
  unknown: 'Other',
};

let profilesCache = null;

async function loadAllProfiles() {
  if (profilesCache) return profilesCache;
  const list = await fetch('/profiles').then((r) => r.json());
  const loaded = await Promise.all(list.map((fname) =>
    fetch(`/profiles/${fname}`).then((r) => r.json())));
  profilesCache = loaded;
  return loaded;
}

export async function pickFixture({ title = 'Add Fixture' } = {}) {
  const profiles = await loadAllProfiles();
  const backdrop = document.getElementById('picker-modal');
  const titleEl = document.getElementById('picker-modal-title');
  const list = document.getElementById('picker-modal-list');
  const cancelBtn = document.getElementById('picker-modal-cancel');
  const confirmBtn = document.getElementById('picker-modal-confirm');

  titleEl.textContent = title;

  // Group by type, ordered: par, wedge, bar, then anything else
  const groups = {};
  for (const p of profiles) {
    const t = p.type || 'unknown';
    (groups[t] ||= []).push(p);
  }
  const order = ['par', 'wedge', 'bar'].filter((k) => groups[k]);
  for (const k of Object.keys(groups)) if (!order.includes(k)) order.push(k);

  let selected = null;

  list.innerHTML = '';
  for (const type of order) {
    const groupEl = document.createElement('div');
    groupEl.className = 'picker-group';
    const h = document.createElement('div');
    h.className = 'picker-group-header';
    h.textContent = TYPE_LABEL[type] || type;
    groupEl.appendChild(h);
    for (const p of groups[type]) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'picker-item';
      item.dataset.name = p.name;
      item.innerHTML = `
        <div class="name">${p.displayName || p.name}</div>
        <div class="meta">${p.channelCount}-channel · ${p.name}</div>
      `;
      item.addEventListener('click', () => {
        selected = p;
        for (const el of list.querySelectorAll('.picker-item')) {
          el.classList.toggle('selected', el === item);
        }
        confirmBtn.disabled = false;
      });
      item.addEventListener('dblclick', () => {
        selected = p;
        finalize();
      });
      groupEl.appendChild(item);
    }
    list.appendChild(groupEl);
  }

  confirmBtn.disabled = true;
  backdrop.classList.add('open');

  return new Promise((resolve) => {
    let settled = false;
    const close = (result) => {
      if (settled) return;
      settled = true;
      backdrop.classList.remove('open');
      cancelBtn.removeEventListener('click', onCancel);
      confirmBtn.removeEventListener('click', onConfirm);
      document.removeEventListener('keydown', onKey, true);
      backdrop.removeEventListener('click', onBackdrop);
      resolve(result);
    };
    function finalize() {
      if (selected) close(selected);
    }
    const onConfirm = () => finalize();
    const onCancel = () => close(null);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter' && selected) { e.preventDefault(); finalize(); }
    };
    const onBackdrop = (e) => { if (e.target === backdrop) close(null); };

    cancelBtn.addEventListener('click', onCancel);
    confirmBtn.addEventListener('click', onConfirm);
    document.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('click', onBackdrop);
  });
}
