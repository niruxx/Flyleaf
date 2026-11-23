import { t } from '../i18n.js';
import { h, icon, iconButton } from '../ui.js';

/** Open an independent reader at another location in the same book. */
export function openParallelPane({ Engine, data, primary, settings, locator }) {
  const text = data.book.engine === 'text';
  const subtitle = h('span.parallel-position');
  const navigation = h('div.parallel-navigation');
  const stage = h('div.stage', { tabIndex: 0, 'aria-label': t('Second reading pane') });
  const loading = h('div.page-loading', h('div.spinner'));
  const pane = h('section.parallel-pane', { 'aria-label': t('Second reading pane') },
    h('header.parallel-toolbar', navigation, subtitle), stage, loading);
  const noop = () => {};
  let closed = false;
  let ready = false;

  function handleKey(e) {
    if (e.target.closest?.('input, select, button, a, textarea') || e.altKey || e.metaKey || e.ctrlKey) return;
    const action = {
      ArrowUp: 'prev', PageUp: 'prev', ArrowDown: 'next', PageDown: 'next',
      ArrowLeft: 'left', ArrowRight: 'right', Home: 'goToStart', End: 'goToEnd',
      ' ': e.shiftKey ? 'prev' : 'next',
    }[e.key];
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    engine[action]?.();
  }
  pane.addEventListener('keydown', (e) => {
    handleKey(e);
    e.stopPropagation();
  });

  const shell = {
    root: pane, stage, settings, reference: true,
    get annotations() { return primary.shell.annotations; },
    set annotations(list) {
      primary.shell.annotations = list;
      primary.setAnnotations(list);
    },
    openSettings: primary.shell.openSettings,
    setLoading: (on) => (loading.hidden = !on),
    setTheme: (bg, fg) => {
      pane.style.setProperty('--reader-bg', bg);
      pane.style.setProperty('--reader-fg', fg);
    },
    setSubtitle: (label) => (subtitle.textContent = label),
    handleKey,
    toast: (message) => (subtitle.textContent = message),
    setPosition: noop, setSlider: noop, setSliderValue: noop, setArrows: noop,
    pageTurned: noop, handleTap: noop, toggleChrome: noop, showChrome: noop,
    setAutoScrollAvailable: noop, autoScrollChanged: noop,
    endPanel: () => h('p.parallel-end', t('End of book')),
  };
  const tracker = { activity: noop, update: noop, saveSettings: noop };
  const engine = new Engine(data.book, shell, tracker, { ...data, reference: true });

  function addNavigation() {
    const sections = text ? engine.parallelSections : [];
    const jump = text
      ? h('select', { 'aria-label': t('Jump to section'), onchange: (e) => {
          const select = e.currentTarget;
          if (select.value) engine.goTo(sections[Number(select.value) - 1].target);
          select.value = '';
        } }, h('option', { value: '' }, t('Jump to section')),
        sections.map(({ label }, i) => h('option', { value: i + 1 }, label)))
      : h('form.parallel-page-jump', { onsubmit: (e) => {
          e.preventDefault();
          engine.goTo(Number(e.currentTarget.elements.page.value) - 1);
        } },
        h('input', { name: 'page', type: 'number', min: 1, max: engine.count, required: true, placeholder: t('Page'),
          'aria-label': t('Jump to page') }),
        h('button.icon-btn.state', { type: 'submit', title: t('Jump to page'), 'aria-label': t('Jump to page') }, icon('arrow_forward')));
    navigation.replaceChildren(
      iconButton('keyboard_arrow_up', t('Scroll up'), () => engine.prev()),
      iconButton('keyboard_arrow_down', t('Scroll down'), () => engine.next()),
      jump);
  }

  // Mount before opening so each engine can measure its own viewport.
  return {
    pane,
    async open() {
      try {
        await engine.open(locator ?? primary.parallelStart(), primary.parallelSource);
        if (!closed) {
          ready = true;
          addNavigation();
        }
      } catch (error) {
        if (closed) return;
        loading.hidden = true;
        stage.replaceChildren(h('p.parallel-end', error.message || t('Couldn’t open the second section.')));
      }
    },
    applySetting(key, value) {
      if (ready) engine.applySetting(key, value);
    },
    setAnnotations(list) {
      if (ready) engine.setAnnotations(list);
    },
    close() {
      closed = true;
      const position = ready ? engine.currentLocator()?.locator : null;
      engine.destroy();
      pane.remove();
      return position;
    },
  };
}
