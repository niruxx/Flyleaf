Error.stackTraceLimit = 0;
const fs = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const uri = (source) => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const source = (file) => fs.readFileSync('public/js/' + file, 'utf8');
const i18nUrl = uri(source('i18n.js'));
const dict = {
  'Page right': 'Página derecha', 'Confirm': 'Confirmar', 'Cancel': 'Cancelar',
  'Ongoing': 'En curso', 'Teen (13+)': 'Adolescentes (13+)',
  '{n} min': '{n} minutos', 'never': 'nunca',
  '{n} book': '{n} libro', '{n} books': '{n} libros',
  'Delete “{name}”?': '¿Eliminar «{name}»?',
};
class Element {
  constructor() { this.children = []; this.attributes = {}; this.classList = { add() {} }; }
  append(...children) { this.children.push(...children); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener() {}
}
global.Node = Element;
global.matchMedia = () => ({ matches: false, addEventListener() {} });
global.document = {
  documentElement: {}, addEventListener() {},
  createElement: () => new Element(), createTextNode: (value) => value,
};
global.localStorage = { getItem: () => null, setItem() {} };
global.fetch = async () => ({ json: async () => dict });
const ready = (async () => {
  const i18n = await import(i18nUrl);
  const keys = await import(uri(source('keybinds.js').replace("'./i18n.js'", JSON.stringify(i18nUrl))));
  const ui = await import(uri(source('ui.js').replace("'./i18n.js'", JSON.stringify(i18nUrl)).replace("'./motion.js'", JSON.stringify(uri('export const leave = () => {};')))));
  return { i18n, keys, ui };
})();

test('labels loaded before language initialization translate when displayed', async () => {
  const { i18n, keys, ui } = await ready;
  await i18n.setLanguage('es');
  assert.equal(keys.ACTIONS[0].label, 'Página derecha');
  assert.equal(ui.STATUS_LABEL.ongoing, 'En curso');
  assert.equal(ui.AGE_RATINGS[2].label, 'Adolescentes (13+)');
});

test('translations preserve key bindings and user-provided names', async () => {
  const { i18n, keys, ui } = await ready;
  await i18n.setLanguage('es');
  assert.equal(keys.keyString({ key: ' ', ctrlKey: true }), 'Ctrl+Space');
  assert.equal(keys.actionFor({ key: 'ArrowRight' }, keys.DEFAULT_KEYBINDS), 'pageRight');
  assert.equal(ui.button('Ongoing').children[0], 'Ongoing');
  assert.equal(i18n.t('Delete “{name}”?', { name: '<My book>' }), '¿Eliminar «<My book>»?');
});

test('counts, time labels and untranslated strings use the selected language and fallback', async () => {
  const { i18n, ui } = await ready;
  await i18n.setLanguage('es');
  assert.equal(i18n.plural(1, '{n} book', '{n} books'), '1 libro');
  assert.equal(i18n.plural(2, '{n} book', '{n} books'), '2 libros');
  assert.equal(ui.formatDuration(120), '2 minutos');
  assert.equal(ui.timeAgo(null), 'nunca');
  assert.equal(i18n.t('Untranslated {name}', { name: 'book' }), 'Untranslated book');
  await i18n.setLanguage('en');
  assert.equal(ui.STATUS_LABEL.ongoing, 'Ongoing');
});

test('locale catalogs include the remaining views without technical strings', () => {
  const template = JSON.parse(fs.readFileSync('public/locales/template.json', 'utf8'));
  const spanish = JSON.parse(fs.readFileSync('public/locales/es.json', 'utf8'));
  for (const key of ['Collections', 'New list', 'Reading stats', 'Upload', 'API & webhooks',
    'Smart spreads', 'Publication status', 'Set goals', 'Create API key', 'No duplicates',
    'End of chapter', 'Footnote', 'Cover artist', 'Same book, different copies']) {
    assert.ok(Object.hasOwn(template, key), key);
    assert.ok(Object.hasOwn(spanish, key), key);
  }
  for (const key of Object.keys(template)) assert.ok(Object.hasOwn(spanish, key), key);
  for (const key of ['contentFinder', 'pageSplit', 'Ctrl', 'X-Flyleaf', 'turn-face front',
    '@font-face{font-family:"{family}";src:url("{url}")}']) {
    assert.equal(Object.hasOwn(template, key), false, key);
  }
});

test('extractor handles both quote styles, escapes and plural keys while preserving translations', () => {
  const vm = require('node:vm');
  const path = require('node:path');
  const writes = new Map();
  const fixture = String.raw` t("Can't reach the Flyleaf server."); t('Line\nnext');
    N_('Reader settings'); plural(count, '{n} book', '{n} books');
    t('Saved'); t('It\'s ready'); t('Caf\u00e9'); `;
  const fakeFs = {
    readdirSync: () => [{ name: 'fixture.js', isDirectory: () => false }],
    readFileSync: (file) => file.endsWith('fixture.js') ? fixture
      : file.endsWith('index.json') ? '[{"code":"es","name":"Espa?ol"}]'
      : '{"Saved":"Guardado"}',
    existsSync: () => true, mkdirSync() {},
    writeFileSync: (file, data) => writes.set(path.basename(file), JSON.parse(data)),
  };
  vm.runInNewContext(fs.readFileSync('scripts/i18n.js', 'utf8'), {
    require: (name) => name === 'node:fs' ? fakeFs : require(name),
    __dirname: path.resolve('scripts'), process: { argv: [] }, console: { log() {} },
  });
  for (const key of ["Can't reach the Flyleaf server.", 'Line\nnext', 'Reader settings',
    '{n} book', '{n} books', "It's ready", 'Caf\u00e9']) assert.ok(Object.hasOwn(writes.get('template.json'), key), key);
  assert.equal(writes.get('es.json').Saved, 'Guardado');
});
