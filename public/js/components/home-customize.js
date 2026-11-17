import { api } from '../api.js';
import { session, render } from '../router.js';
import { h, button, iconButton, dialog, field } from '../ui.js';
import { t } from '../i18n.js';
import { homeLayout, HOME_SECTIONS, HOME_SORTS } from '../home-layout.js';

export function customizeHome() {
  let saving = false;
  let draft = homeLayout(session.user.prefs?.home);
  const body = h('div.home-customize');
  const draw = () => {
    const sort = field(t('Organize shelf contents'), { value: draft.sort, options: HOME_SORTS.map(([value, label]) => ({ value, label: t(label) })) });
    sort.querySelector('select').addEventListener('change', e => { draft.sort = e.target.value; });
    const toggle = (label, checked, change) => h('label.home-toggle',
      h('input', { type: 'checkbox', checked, onchange: e => change(e.target.checked) }), h('span', label));
    body.replaceChildren(
      h('p.muted', t('Choose what appears on Home. Sorting changes the order of items within each shelf; recent shelves keep their recent selection.')),
      sort,
      toggle(t('Show welcome banner'), draft.hero, value => { draft.hero = value; }),
      toggle(t('Show reading shortcuts'), draft.shortcuts, value => { draft.shortcuts = value; }),
      toggle(t('Compact cards'), draft.compact, value => { draft.compact = value; }),
      h('h3', t('Sections')),
      ...draft.order.map((id, index) => {
        const label = t(HOME_SECTIONS.find(([key]) => key === id)[1]);
        const move = offset => { [draft.order[index], draft.order[index + offset]] = [draft.order[index + offset], draft.order[index]]; draw(); body.querySelector(`[data-section="${id}"] input`)?.focus(); };
        const up = iconButton('arrow_upward', t('Move {title} up', { title: label }), () => move(-1));
        const down = iconButton('arrow_downward', t('Move {title} down', { title: label }), () => move(1));
        up.disabled = index === 0; down.disabled = index === draft.order.length - 1;
        return h('div.home-section-choice', { dataset: { section: id } },
          toggle(label, !draft.hidden.includes(id), visible => { draft.hidden = visible ? draft.hidden.filter(key => key !== id) : [...draft.hidden, id]; }), up, down);
      }),
      button(t('Reset to defaults'), { variant: 'text', onclick: () => { draft = homeLayout(null); draw(); } }),
    );
  };
  draw();
  return dialog({ title: t('Customize home'), icon: 'dashboard_customize', content: body, actions: [
    { label: t('Cancel') },
    { label: t('Save'), variant: 'filled', onClick: async close => {
      if (saving) return false;
      saving = true;
      const error = body.querySelector('.home-save-error'); error?.remove();
      try {
        const home = homeLayout(draft);
        await api.savePrefs({ home });
        session.user.prefs = { ...session.user.prefs, home };
        close(true); render();
      } catch (e) { body.append(h('p.home-save-error', { role: 'alert' }, e.message)); }
      finally { saving = false; }
      return false;
    } },
  ] });
}
