// Source choices are isolated by account and browser. Storage failures remain non-fatal.
export function sourceHealth(storage, userId) {
  const key = `flyleaf.finder.health.${userId}`;
  let saved;
  try { saved = JSON.parse(storage.getItem(key)); } catch {}
  let hideFailed = saved?.hideFailed === true;
  const disabled = new Set(Array.isArray(saved?.disabled) ? saved.disabled.filter(v => typeof v === 'string') : []);
  const failures = new Map(Array.isArray(saved?.failures) ? saved.failures.filter(v => Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string') : []);
  function save() {
    try { storage.setItem(key, JSON.stringify({ hideFailed, disabled: [...disabled], failures: [...failures].slice(-200) })); } catch {}
  }
  return {
    failures, disabled,
    get hideFailed() { return hideFailed; },
    setHide(value) { hideFailed = Boolean(value); save(); },
    setDisabled(id, value) { value ? disabled.add(id) : disabled.delete(id); save(); },
    fail(id, error) { failures.set(id, String(error).slice(0, 500)); save(); },
    clear(id) { failures.delete(id); save(); },
    allows(id) { return !disabled.has(id) && !(hideFailed && failures.has(id)); },
  };
}
