// Fixture outliner — collapsible left-side panel listing all fixtures in the
// scene, grouped by type. Selection flows out via the `onSelect` callback;
// caller is responsible for the in-3D selection indicator.

const TYPE_LABELS = {
  par: 'Pars',
  bar: 'Bars',
  unknown: 'Other',
};

export function createOutliner({ fixtures, onSelect, onOrient, onYaw }) {
  const rootEl = document.getElementById('outliner');
  const tab = document.getElementById('outliner-tab');
  const closeBtn = document.getElementById('outliner-close');
  const tree = document.getElementById('outliner-tree');

  // Fixed iteration order for known kinds; anything else falls in after.
  const PREFERRED_ORDER = ['par', 'wedge', 'bar'];

  let selectedId = null;
  const collapsedGroups = new Set();

  function render() {
    // Rebuild groups from the LIVE `fixtures` array each render so adds /
    // removes show up. Keeps array order within each group, so the list
    // mirrors fixture creation order.
    const groups = {};
    for (const f of fixtures) {
      const kind = f.kind || 'unknown';
      (groups[kind] ||= []).push(f);
    }
    const groupOrder = PREFERRED_ORDER.filter((k) => groups[k]);
    for (const k of Object.keys(groups)) if (!groupOrder.includes(k)) groupOrder.push(k);

    tree.innerHTML = '';
    for (const kind of groupOrder) {
      const list = groups[kind];
      const group = document.createElement('div');
      group.className = 'group' + (collapsedGroups.has(kind) ? ' collapsed' : '');

      const header = document.createElement('div');
      header.className = 'group-header';
      const caret = collapsedGroups.has(kind) ? '▸' : '▾';
      header.innerHTML = `<span><span class="caret">${caret}</span> ${TYPE_LABELS[kind] || kind}</span><span class="count">${list.length}</span>`;
      header.addEventListener('click', () => {
        if (collapsedGroups.has(kind)) collapsedGroups.delete(kind);
        else collapsedGroups.add(kind);
        render();
      });
      group.appendChild(header);

      const items = document.createElement('div');
      items.className = 'group-items';
      for (const f of list) {
        const item = document.createElement('div');
        item.className = 'fixture-item' + (f.patch.fixtureId === selectedId ? ' selected' : '');
        item.dataset.id = f.patch.fixtureId;
        const mountTag = `<span class="mount-tag ${f.mount}">${f.mount}</span>`;

        // Floor-mounted bars get an orientation toggle. Click cycles between
        // horizontal (default, lying flat) and vertical (standing upright).
        let orientBtn = '';
        if (f.kind === 'bar' && f.mount === 'floor') {
          const cur = f.orientation || 'horizontal';
          orientBtn = `<button class="orient-btn" data-orient="${cur}" title="Click to toggle orientation">${cur}</button>`;
        }

        // When selected, expand to show a yaw slider for any floor fixture.
        // Yaw on a par spins it around vertical (re-aims an uplight). Yaw on
        // a bar rotates its footprint, which affects drag collision.
        let yawRow = '';
        if (f.patch.fixtureId === selectedId && f.mount === 'floor') {
          const deg = Math.round(((f.yaw || 0) * 180 / Math.PI));
          yawRow = `
            <div class="yaw-row">
              <label>yaw</label>
              <input type="range" class="yaw-slider" min="-180" max="180" step="1" value="${deg}">
              <span class="yaw-val">${deg}°</span>
            </div>
          `;
        }

        item.innerHTML = `
          <div class="id-row">
            <span class="id">${f.patch.fixtureId}</span>
            ${orientBtn}${mountTag}
          </div>
          <div class="meta">${f.profile.name} · U${f.patch.universe}:${f.patch.startAddress}</div>
          ${yawRow}
        `;

        // Handle clicks: orient button toggles orientation and stops propagation
        // so it doesn't also fire selection. Selection itself is REPORTED via
        // onSelect — the caller owns toggle logic and tells us back which row
        // to highlight (via setSelection). This keeps the 3D view and sidebar
        // in sync from a single source of truth.
        item.addEventListener('click', (e) => {
          const btn = e.target.closest('.orient-btn');
          if (btn) {
            e.stopPropagation();
            const next = (f.orientation || 'horizontal') === 'horizontal' ? 'vertical' : 'horizontal';
            onOrient?.(f, next);
            render();
            return;
          }
          if (e.target.closest('.yaw-row')) return;
          onSelect?.(f);
        });

        // Wire the yaw slider if present. Update label live + push to caller.
        const slider = item.querySelector('.yaw-slider');
        if (slider) {
          const valEl = item.querySelector('.yaw-val');
          slider.addEventListener('input', () => {
            const deg = Number(slider.value);
            valEl.textContent = deg + '°';
            onYaw?.(f, deg * Math.PI / 180);
          });
        }
        items.appendChild(item);
      }
      group.appendChild(items);
      tree.appendChild(group);
    }
  }

  tab.addEventListener('click', () => rootEl.classList.remove('collapsed'));
  closeBtn.addEventListener('click', () => rootEl.classList.add('collapsed'));

  render();

  return {
    setSelection(fixture) {
      const newId = fixture ? fixture.patch.fixtureId : null;
      if (newId === selectedId) return;
      selectedId = newId;
      render();
    },
    // Re-render with current state. Call when an external action (e.g.
    // Ctrl+wheel yaw) changes a fixture property the outliner displays.
    refresh() { render(); },
  };
}
