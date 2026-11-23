import { t } from '../i18n.js';
import { h, iconButton, snackbar } from '../ui.js';

/** Sentence ranges refer to the original DOM; speaking never inserts text or marks. */
export function sentences(doc, language) {
  let segmenter;
  try { segmenter = new Intl.Segmenter(language || undefined, { granularity: 'sentence' }); }
  catch { segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' }); }
  const groups = [];
  const walker = doc.createTreeWalker(doc.body, 4);
  let group;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!node.data || parent.closest('script,style,noscript,svg,math,rt,rp,[hidden],[aria-hidden="true"]')) continue;
    let hidden = false;
    for (let el = parent; el; el = el.parentElement) {
      const style = doc.defaultView?.getComputedStyle(el);
      if (style?.display === 'none' || style?.visibility === 'hidden') { hidden = true; break; }
    }
    if (hidden) continue;
    const block = parent.closest('p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th,div,section') || doc.body;
    if (group?.block === block) {
      const between = doc.createRange();
      between.setStartAfter(group.nodes.at(-1).node);
      between.setEndBefore(node);
      if (between.cloneContents().querySelector('br')) group = null;
    }
    if (group?.block !== block) groups.push(group = { block, text: '', nodes: [] });
    group.nodes.push({ node, start: group.text.length });
    group.text += node.data;
  }
  const result = [];
  const rangeFor = (nodes, start, end) => {
    const first = nodes.findLast(n => n.start <= start);
    const last = nodes.findLast(n => n.start < end);
    const range = doc.createRange();
    range.setStart(first.node, start - first.start);
    range.setEnd(last.node, end - last.start);
    return range;
  };
  for (const { text, nodes } of groups) for (const sentence of segmenter.segment(text)) {
    // Short utterances avoid browser speech-service limits on long paragraphs.
    let start = sentence.index, end = start + sentence.segment.length;
    const sentenceRange = rangeFor(nodes, start, end);
    while (start < end) {
      let stop = Math.min(end, start + 240);
      if (stop < end) {
        const space = text.lastIndexOf(' ', stop);
        if (space > start + 100) stop = space + 1;
        if (/[\uD800-\uDBFF]/.test(text[stop - 1])) stop--;
      }
      const spoken = text.slice(start, stop);
      if (spoken.trim()) {
        const range = rangeFor(nodes, start, stop);
        result.push({ text: spoken, range, sentenceRange, language: range.startContainer.parentElement.closest('[lang]')?.getAttribute('lang') || language });
      }
      start = stop;
    }
  }
  return result;
}

export class SpeechPlayer {
  constructor(adapter, { synth = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance,
    setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
    Object.assign(this, { adapter, synth, Utterance, setTimer, clearTimer, now });
    this.setTimer = (fn, ms) => setTimer.call(globalThis, fn, ms);
    this.clearTimer = timer => clearTimer.call(globalThis, timer);
    this.rate = 1;
    this.state = 'stopped';
    this.generation = 0;
  }
  notify() { this.adapter.changed?.(this); }
  cancel() {
    this.generation++;
    this.moving = false;
    this.synth.cancel();
    this.utterance = null;
  }
  async start() {
    if (this.state === 'playing' || this.destroyed) return;
    if (this.state === 'stopped') {
      this.items = null;
      this.cursor = 0;
    }
    this.state = 'playing';
    const generation = ++this.generation;
    this.notify();
    await this.speak(generation);
  }
  pause() {
    if (this.state !== 'playing') return;
    this.cancel(); // Resume repeats the current sentence across browser implementations.
    this.state = 'paused';
    this.notify();
  }
  stop() {
    this.cancel();
    this.state = 'stopped';
    this.items = null;
    this.adapter.clear?.();
    this.clearTimer(this.timer);
    this.until = null;
    this.notify();
  }
  setRate(rate) {
    this.rate = Math.max(0.5, Math.min(2, Number(rate) || 1));
    if (this.state === 'playing') { this.pause(); void this.start(); }
    this.notify();
  }
  setSleep(minutes) {
    this.clearTimer(this.timer);
    this.until = minutes > 0 ? this.now() + minutes * 60000 : null;
    if (this.until) this.timer = this.setTimer(() => this.stop(), minutes * 60000);
    this.notify();
  }
  async speak(generation) {
    const current = () => !this.destroyed && generation === this.generation && this.state === 'playing';
    try {
      if (!current()) return;
      if (this.until && this.now() >= this.until) return this.stop();
      this.moving = true;
      try {
        if (!this.items) {
          const loaded = await this.adapter.load(false);
          if (!current()) return;
          this.items = loaded.items;
          this.cursor = loaded.start || 0;
        }
        // Skip image-only/empty sections, but never loop past the end of the book.
        while (this.cursor >= this.items.length) {
          const loaded = await this.adapter.load(true);
          if (!current()) return;
          if (!loaded) return this.stop();
          this.items = loaded.items;
          this.cursor = 0;
        }
        await this.adapter.show(this.items[this.cursor]);
        if (!current()) return;
      } finally { if (generation === this.generation) this.moving = false; }
      const item = this.items[this.cursor];
      if (this.until && this.now() >= this.until) return this.stop();
      const utterance = new this.Utterance(item.text);
      utterance.rate = this.rate;
      utterance.lang = item.language || this.adapter.language || '';
      const voices = this.synth.getVoices();
      utterance.voice = voices.find(v => v.lang.toLowerCase() === utterance.lang.toLowerCase())
        || voices.find(v => v.lang.split('-')[0] === utterance.lang.split('-')[0]) || null;
      utterance.onend = () => {
        if (!current()) return;
        this.cursor++;
        void this.speak(generation);
      };
      utterance.onerror = event => {
        if (!current()) return;
        this.stop();
        this.adapter.error?.(event.error);
      };
      this.utterance = utterance; // Keep a strong reference until the callback.
      this.synth.speak(utterance);
    } catch (error) {
      if (current()) { this.stop(); this.adapter.error?.(error.message); }
    }
  }
  destroy() { this.destroyed = true; this.stop(); }
}

export function readAloudControls(player, root) {
  const status = h('span.label-medium', { role: 'status', 'aria-live': 'polite' });
  const play = iconButton('play_arrow', t('Read aloud'), () => {
    if (player.state === 'playing') player.pause();
    else void player.start();
  });
  const speed = h('select', { 'aria-label': t('Speech speed'), onchange: event => player.setRate(event.target.value) },
    [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(rate => h('option', { value: rate, selected: rate === player.rate }, `${rate}×`)));
  const sleep = h('select', { 'aria-label': t('Sleep timer'), onchange: event => player.setSleep(Number(event.target.value)) },
    h('option', { value: 0 }, t('Sleep timer off')), [5, 10, 15, 30, 60].map(minutes => h('option', { value: minutes }, t('{value} min', { value: minutes }))));
  const bar = h('div.read-aloud-bar', { role: 'region', 'aria-label': t('Read aloud') },
    play, iconButton('stop', t('Stop reading aloud'), () => player.stop()), status,
    h('label', t('Speed'), speed), h('label', t('Sleep'), sleep),
    iconButton('close', t('Close read aloud'), () => { player.stop(); bar.remove(); }));
  player.adapter.changed = () => {
    play.querySelector('.icon').textContent = player.state === 'playing' ? 'pause' : 'play_arrow';
    play.title = player.state === 'playing' ? t('Pause read aloud') : t('Read aloud');
    play.setAttribute('aria-label', play.title);
    status.textContent = player.state === 'playing' ? t('Reading aloud') : player.state === 'paused' ? t('Paused') : t('Read aloud');
    if (!player.until) sleep.value = '0';
  };
  player.adapter.error = () => snackbar(t('Read aloud could not start. Check your browser speech voices and try again.'));
  player.notify();
  root.append(bar);
  return bar;
}
