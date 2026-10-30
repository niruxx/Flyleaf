// Source choices are isolated by account and browser. Storage failures remain non-fatal.
export function sourceHealth(storage, userId) {
  const key = `flyleaf.finder.health.${userId}`;
  let saved;
  try { saved = JSON.parse(storage.getItem(key)); } catch {}
  let disableFailing = saved?.disableFailing === true;
  let hideFailed = saved?.hideFailed === true;
  const disabled = new Set(Array.isArray(saved?.disabled) ? saved.disabled.filter(v => typeof v === 'string') : []);
  const failures = new Map(Array.isArray(saved?.failures) ? saved.failures.filter(v => Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string') : []);
  function save() {
    try { storage.setItem(key, JSON.stringify({ disableFailing, hideFailed, disabled: [...disabled], failures: [...failures].slice(-200) })); } catch {}
  }
  return {
    failures, disabled,
    get disableFailing() { return disableFailing; },
    setDisableFailing(value) { disableFailing = Boolean(value); save(); },
    disableFailed(ids = failures.keys()) {
      let count = 0;
      for (const id of ids) if (failures.has(id) && !disabled.has(id)) { disabled.add(id); count++; }
      save();
      return count;
    },
    get hideFailed() { return hideFailed; },
    setHide(value) { hideFailed = Boolean(value); save(); },
    setDisabled(id, value) { value ? disabled.add(id) : disabled.delete(id); save(); },
    fail(id, error) { failures.set(id, String(error).slice(0, 500)); if (disableFailing) disabled.add(id); save(); },
    clear(id) { failures.delete(id); save(); },
    allows(id) { return !disabled.has(id) && !(hideFailed && failures.has(id)); },
  };
}
