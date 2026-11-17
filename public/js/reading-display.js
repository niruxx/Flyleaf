// Engines receive a live display overlay; settings forms and persistence keep the original object.
export function displaySettings(settings, eink) {
  const overrides = { look: 'eink', pageTurn: 'none', textTheme: 'light', background: '#ffffff' };
  return new Proxy(settings, { get(target, key) {
    return eink() && Object.hasOwn(overrides, key) ? overrides[key] : Reflect.get(target, key);
  } });
}
