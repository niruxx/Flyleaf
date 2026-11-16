const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('public/js/reader/read-aloud.js', 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
const { SpeechPlayer } = vm.runInNewContext(`${source}\n({SpeechPlayer})`, { Intl, setTimeout, clearTimeout, Date });

function setup(adapter = {}) {
  const spoken = [], highlights = [], timers = new Map();
  let cancellations = 0, clears = 0, time = 100;
  const player = new SpeechPlayer({
    language: 'en-US', load: async next => next ? null : { items: [{ text: 'First.' }, { text: 'Second.' }] },
    show: async item => highlights.push(item.text), clear: () => clears++, ...adapter,
  }, { synth: { speak: u => spoken.push(u), cancel: () => cancellations++, getVoices: () => [{ lang: 'en-US' }] },
    Utterance: class { constructor(text) { this.text = text; } },
    setTimer: (fn, ms) => { const id = Symbol(); timers.set(id, { fn, ms }); return id; }, clearTimer: id => timers.delete(id), now: () => time });
  return { player, spoken, highlights, timers, cancellations: () => cancellations, clears: () => clears, setTime: value => { time = value; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('speech advances one sentence at a time, highlights it, and finishes cleanly', async () => {
  const x = setup();
  await x.player.start();
  assert.equal(x.spoken[0].text, 'First.');
  assert.equal(x.spoken[0].lang, 'en-US');
  assert.equal(x.spoken[0].voice.lang, 'en-US');
  x.spoken[0].onend(); await settle();
  assert.equal(x.spoken[1].text, 'Second.');
  assert.deepEqual(x.highlights, ['First.', 'Second.']);
  x.spoken[1].onend(); await settle();
  assert.equal(x.player.state, 'stopped');
  assert.ok(x.clears());
});

test('pause, speed changes, stop and destroy invalidate stale speech callbacks', async () => {
  const x = setup();
  await x.player.start(); const first = x.spoken[0];
  x.player.pause(); first.onend(); await settle();
  assert.equal(x.spoken.length, 1);
  await x.player.start();
  assert.equal(x.spoken[1].text, 'First.', 'resume repeats the current sentence');
  x.player.setRate(1.5); await settle();
  assert.equal(x.spoken.at(-1).rate, 1.5);
  x.spoken[1].onend(); await settle();
  assert.equal(x.spoken.length, 3);
  const last = x.spoken.at(-1); x.player.destroy(); last.onend(); await settle();
  assert.equal(x.player.state, 'stopped');
  assert.equal(x.spoken.length, 3);
});

test('sleep expiry stops playback and prevents queued speech after a stalled page', async () => {
  const x = setup(); await x.player.start();
  x.player.setSleep(5);
  assert.equal([...x.timers.values()][0].ms, 300000);
  x.setTime(300101);
  x.spoken[0].onend(); await settle();
  assert.equal(x.spoken.length, 1);
  assert.equal(x.player.state, 'stopped');
  assert.equal(x.timers.size, 0);
  x.player.setSleep(10); [...x.timers.values()][0].fn();
  assert.equal(x.player.until, null);
});

test('cancellation during chapter loading cannot restart speech', async () => {
  let release;
  const x = setup({ load: () => new Promise(resolve => { release = resolve; }) });
  const starting = x.player.start(); x.player.stop();
  release({ items: [{ text: 'Too late.' }] }); await starting;
  assert.equal(x.spoken.length, 0);
  assert.equal(x.player.moving, false);
});

test('empty chapters are skipped and speech errors clear playback and highlighting', async () => {
  let chapter = 0, error;
  const x = setup({ load: async next => {
    if (next) chapter++;
    return chapter < 2 ? { items: [] } : chapter === 2 ? { items: [{ text: 'Chapter three.' }] } : null;
  }, error: value => { error = value; } });
  await x.player.start(); assert.equal(x.spoken[0].text, 'Chapter three.');
  x.spoken[0].onerror({ error: 'voice-unavailable' });
  assert.equal(error, 'voice-unavailable'); assert.equal(x.player.state, 'stopped');
  assert.ok(x.clears());
});
