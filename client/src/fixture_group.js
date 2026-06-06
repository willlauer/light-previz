// Fixture-group dialog — collects the parameters for placing a row of N
// identical fixtures with auto-chained DMX addresses. Resolves with
// { count, universe, base, spacing, axis } or null if cancelled.
//
// Each fixture in the group is patched at base + i * channelCount, so the
// whole row occupies one contiguous DMX block. The live summary shows the
// resulting block and turns red (disabling Place) if it would run past 512.

export async function pickGroupParams(profile, { defaultBase = 1 } = {}) {
  const backdrop = document.getElementById('group-modal');
  const titleEl = document.getElementById('group-modal-title');
  const countEl = document.getElementById('group-count');
  const uniEl = document.getElementById('group-universe');
  const baseEl = document.getElementById('group-base');
  const spacingEl = document.getElementById('group-spacing');
  const axisEl = document.getElementById('group-axis');
  const summaryEl = document.getElementById('group-modal-summary');
  const cancelBtn = document.getElementById('group-modal-cancel');
  const confirmBtn = document.getElementById('group-modal-confirm');

  const ch = profile.channelCount;
  titleEl.textContent = `Add ${profile.displayName || profile.name} Group`;

  // Seed defaults each time the dialog opens.
  countEl.value = countEl.value && Number(countEl.value) >= 1 ? countEl.value : 4;
  uniEl.value = 0;
  baseEl.value = Math.max(1, Math.min(512, defaultBase));
  if (!spacingEl.value) spacingEl.value = 1;

  // Read + clamp the current field values into a normalized params object.
  function read() {
    const count = Math.max(1, Math.floor(Number(countEl.value) || 1));
    const universe = Math.max(0, Math.min(32767, Math.floor(Number(uniEl.value) || 0)));
    const base = Math.max(1, Math.min(512, Math.floor(Number(baseEl.value) || 1)));
    const spacing = Math.max(0, Number(spacingEl.value) || 0);
    const axis = axisEl.value === 'z' ? 'z' : 'x';
    return { count, universe, base, spacing, axis };
  }

  function update() {
    const { count, universe, base } = read();
    const total = count * ch;
    const last = base + total - 1;
    const overflow = last > 512;
    const lastBase = base + (count - 1) * ch;
    summaryEl.classList.toggle('error', overflow);
    if (overflow) {
      summaryEl.textContent =
        `${count} × ${ch}ch = ${total} channels would end at U${universe}:${last} — past the 512-channel limit.`;
    } else {
      summaryEl.textContent =
        `${count} × ${ch}ch · block U${universe}:${base}→${last} · last fixture U${universe}:${lastBase}→${last}`;
    }
    confirmBtn.disabled = overflow;
  }

  for (const el of [countEl, uniEl, baseEl, spacingEl, axisEl]) {
    el.addEventListener('input', update);
  }
  update();

  backdrop.classList.add('open');

  return new Promise((resolve) => {
    let settled = false;
    const close = (result) => {
      if (settled) return;
      settled = true;
      backdrop.classList.remove('open');
      for (const el of [countEl, uniEl, baseEl, spacingEl, axisEl]) {
        el.removeEventListener('input', update);
      }
      cancelBtn.removeEventListener('click', onCancel);
      confirmBtn.removeEventListener('click', onConfirm);
      document.removeEventListener('keydown', onKey, true);
      backdrop.removeEventListener('click', onBackdrop);
      resolve(result);
    };
    const onConfirm = () => { if (!confirmBtn.disabled) close(read()); };
    const onCancel = () => close(null);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter' && !confirmBtn.disabled) { e.preventDefault(); close(read()); }
    };
    const onBackdrop = (e) => { if (e.target === backdrop) close(null); };

    cancelBtn.addEventListener('click', onCancel);
    confirmBtn.addEventListener('click', onConfirm);
    document.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('click', onBackdrop);
  });
}
