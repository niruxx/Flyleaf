import { api } from '../api.js';
import { session, navigate } from '../router.js';
import { h, icon, field, button, formError } from '../ui.js';
import { afterSignIn } from '../shell.js';
import { onboardFrame, STEPS } from './welcome.js';

const FEATURES = [
  ['auto_stories', 'Books, manga & comics', 'EPUB, PDF, CBZ, CBR and more – read right in the browser.'],
  ['sync', 'Pick up where you left off', 'Progress, bookmarks and highlights follow you to every device.'],
  ['insights', 'Reading stats & goals', 'Streaks, a yearly goal and your year in review.'],
  ['rss_feed', 'Works with your apps', 'OPDS for KOReader, Panels, Chunky, Thorium and others.'],
];

const greeting = () => {
  const hr = new Date().getHours();
  return hr < 5 ? 'Up late reading?' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
};

/** Animated backdrop: drifting colour blobs, a dot grid and floating books. */
function backdrop() {
  const books = Array.from({ length: 14 }, (_, i) => h('span.auth-book', {
    style: {
      '--x': `${(i * 37 + 7) % 100}%`,
      '--d': `${18 + ((i * 7) % 14)}s`,
      '--delay': `${-((i * 3.3) % 20)}s`,
      '--s': String(0.6 + ((i * 13) % 10) / 14),
      '--r': `${((i * 47) % 50) - 25}deg`,
    },
  }));
  return h('div.auth-backdrop', { 'aria-hidden': 'true' },
    h('span.blob.b1'), h('span.blob.b2'), h('span.blob.b3'),
    h('div.auth-dots'),
    h('div.auth-books', books));
}

/** Left-hand showcase on wide screens; a compact strip above the card on phones. */
function showcase({ eyebrow, title, text, points = FEATURES }) {
  return h('aside.auth-showcase',
    h('div.auth-brand', h('span.logo', icon('auto_stories', 'filled')), h('span.title-large', 'Flyleaf')),
    h('div.auth-eyebrow.label-large', eyebrow),
    h('h1.auth-headline', title),
    h('p.body-large.auth-lead', text),
    h('ul.auth-features', points.map(([ic, t, s], i) =>
      h('li', { style: { '--i': String(i) } }, h('span.f-icon', icon(ic)), h('div', h('div.title-small', t), h('div.body-small', s))))),
  );
}

function shell(title, subtitle, form, { aside = {} } = {}) {
  const card = h('div.auth-card',
    h('div.auth-card-head',
      h('h2.headline-small', title),
      h('p.body-medium.muted', subtitle)),
    form);
  const root = h('div.auth', backdrop(), h('div.auth-layout',
    showcase({ eyebrow: greeting(), title: 'Your library, everywhere.', text: 'Every book, manga and comic you own, beautifully organised and ready to read on any screen.', ...aside }),
    card));
  // Cards tilt a little towards the pointer on desktop.
  root.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const r = card.getBoundingClientRect();
    const x = (e.clientX - (r.left + r.width / 2)) / innerWidth;
    const y = (e.clientY - (r.top + r.height / 2)) / innerHeight;
    root.style.setProperty('--tx', x.toFixed(3));
    root.style.setProperty('--ty', y.toFixed(3));
  });
  return root;
}

/** Shake the card and show an error. */
function fail(err, message, card) {
  err.replaceChildren(formError(message));
  card?.classList.remove('shake');
  void card?.offsetWidth;
  card?.classList.add('shake');
}

/** Small "Caps Lock is on" hint under a password field. */
function capsHint(passField) {
  const hint = h('div.caps-hint', { hidden: true }, icon('keyboard_capslock'), 'Caps Lock is on');
  const check = (e) => (hint.hidden = !e.getModifierState?.('CapsLock'));
  passField.input.addEventListener('keydown', check);
  passField.input.addEventListener('keyup', check);
  passField.input.addEventListener('blur', () => (hint.hidden = true));
  return hint;
}

/** Password strength 0–4 with a label. */
function strength(p) {
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 12) s++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
  if (/\d/.test(p) && /[^A-Za-z0-9]/.test(p)) s++;
  if (p.length < 8) s = Math.min(s, 1);
  return s;
}
function strengthMeter(passField) {
  const LABELS = ['Too short', 'Weak', 'Okay', 'Good', 'Strong'];
  const bar = h('div.strength', { 'data-level': '0' }, h('span'), h('span'), h('span'), h('span'), h('em.label-small', ''));
  passField.input.addEventListener('input', () => {
    const v = passField.input.value;
    const s = v ? strength(v) : 0;
    bar.dataset.level = v ? String(Math.max(1, s)) : '0';
    bar.querySelector('em').textContent = v ? LABELS[s] : '';
  });
  return bar;
}

export function setupView(view) {
  const name = field('Your name', { autocomplete: 'name', support: 'Shown in the app. Optional.' });
  const user = field('Admin username', { autocomplete: 'username', required: true, autocapitalize: 'none', support: '3–32 letters, numbers, . - _' });
  const email = field('Email', { type: 'email', autocomplete: 'email', support: 'Optional – lets you sign in with your email too.' });
  const pass = field('Password', { type: 'password', autocomplete: 'new-password', required: true, support: 'At least 8 characters.' });
  const pass2 = field('Confirm password', { type: 'password', autocomplete: 'new-password', required: true });
  const err = h('div');
  const submit = button('Create account', { type: 'submit', icon: 'arrow_forward' });

  const form = h(
    'form.ob-form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.replaceChildren();
        if (pass.input.value !== pass2.input.value) {
          err.append(formError("Passwords don't match."));
          return;
        }
        submit.disabled = true;
        try {
          const { user: u } = await api.setup({ username: user.input.value.trim(), password: pass.input.value, displayName: name.input.value, email: email.input.value.trim() });
          session.user = u;
          afterSignIn();
          navigate('/welcome', { replace: true });
        } catch (e2) {
          err.append(formError(e2.message));
          submit.disabled = false;
        }
      },
    },
    err,
    h('div.ob-grid2', name, email),
    user,
    h('div.ob-grid2', pass, pass2),
    h('div.ob-perks',
      h('div', icon('admin_panel_settings'), 'You’ll manage libraries, metadata and guests.'),
      h('div', icon('lock'), 'Passwords are hashed with scrypt and never leave this server.'),
    ),
    h('div.ob-form-foot', submit),
  );

  // Moving servers: start from a backup instead of a new admin account.
  const restoreSlot = h('div', { style: { marginTop: '16px' } },
    button('Restore from a backup instead', { variant: 'text', icon: 'settings_backup_restore', onclick: async () => {
      const { restoreGroup } = await import('./settings-platform.js');
      restoreSlot.replaceChildren(restoreGroup({
        setup: true,
        onDone: (r) => {
          sessionStorage.setItem('flyleaf.after-login', '/');
          restoreSlot.replaceChildren(h('div.form-error', { style: { background: 'var(--md-primary-container)', color: 'var(--md-on-primary-container)' } },
            icon('task_alt'), h('span', `Restored${r.bookFiles ? ` with ${r.bookFiles} book files` : ''}. Sign in with an account from the backup.`)));
          setTimeout(() => {
            location.hash = '#/login';
            location.reload();
          }, 1800);
        },
      }));
    } }));
  form.append(restoreSlot);

  view.append(
    onboardFrame(STEPS, 0, {
      title: 'Welcome to Flyleaf',
      subtitle: 'Your own library for books, manga and comics. Let’s start with the admin account.',
      content: form,
    }),
  );
  user.input.focus();
}

export function loginView(view) {
  const user = field('Username or email', { autocomplete: 'username', required: true, autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false' });
  const pass = field('Password', { type: 'password', autocomplete: 'current-password', required: true });
  const err = h('div');
  const submit = button('Sign in', { type: 'submit', icon: 'login' });
  let root;

  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.replaceChildren();
        submit.disabled = true;
        submit.classList.add('busy');
        try {
          const { user: u } = await api.login({ username: user.input.value.trim(), password: pass.input.value });
          session.user = u;
          root.classList.add('leaving');
          afterSignIn();
          const next = sessionStorage.getItem('flyleaf.after-login');
          sessionStorage.removeItem('flyleaf.after-login');
          setTimeout(() => navigate(next && next !== '/login' && next !== '/setup' ? next : '/', { replace: true }), 260);
        } catch (e2) {
          fail(err, e2.message, root.querySelector('.auth-card'));
          submit.disabled = false;
          submit.classList.remove('busy');
          pass.input.select();
        }
      },
    },
    err,
    user,
    pass,
    capsHint(pass),
    submit,
  );
  // "Create an account" only when the admin has turned sign-up on.
  const signup = h('div.auth-alt');
  api.status().then((st) => {
    if (st.registration) signup.append(h('span.muted', 'New here? '), h('a', { href: '#/register' }, 'Create an account'));
  }).catch(() => {});
  root = shell('Welcome back', 'Sign in to your library.', h('div', form, signup,
    h('p.auth-fine.body-small', icon('lock'), 'You stay signed in on this device until you sign out.')));
  view.append(root);
  user.input.focus();
}

export async function registerView(view) {
  const st = await api.status().catch(() => null);
  if (!st?.registration) {
    view.append(shell('Flyleaf', 'Sign-up is closed. Ask the admin for an account.', h('div', button('Back to sign in', { variant: 'tonal', icon: 'arrow_back', onclick: () => navigate('/login', { replace: true }) }))));
    return;
  }
  const name = field('Your name', { autocomplete: 'name', support: 'Shown in the app. Optional.' });
  const user = field('Username', { autocomplete: 'username', required: true, autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', support: '3–32 letters, numbers, . - _' });
  const pass = field('Password', { type: 'password', autocomplete: 'new-password', required: true, support: 'At least 8 characters.' });
  const pass2 = field('Confirm password', { type: 'password', autocomplete: 'new-password', required: true });
  const invite = st.registration.inviteRequired && field('Invite code', { required: true, autocomplete: 'off', autocapitalize: 'none', support: 'You got this from whoever runs this Flyleaf.' });
  const err = h('div');
  const submit = button('Create account', { type: 'submit', icon: 'person_add' });
  let root;
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.replaceChildren();
        if (pass.input.value !== pass2.input.value) {
          fail(err, "Passwords don't match.", root.querySelector('.auth-card'));
          return;
        }
        submit.disabled = true;
        submit.classList.add('busy');
        try {
          const { user: u } = await api.register({
            username: user.input.value.trim(),
            password: pass.input.value,
            displayName: name.input.value,
            inviteCode: invite ? invite.input.value.trim() : undefined,
          });
          session.user = u;
          root.classList.add('leaving');
          afterSignIn();
          setTimeout(() => navigate('/welcome', { replace: true }), 260);
        } catch (e2) {
          fail(err, e2.message, root.querySelector('.auth-card'));
          submit.disabled = false;
          submit.classList.remove('busy');
        }
      },
    },
    err,
    h('div.ob-grid2', name, user),
    pass,
    strengthMeter(pass),
    capsHint(pass),
    pass2,
    invite,
    submit,
  );
  root = shell('Create your account', 'It takes a few seconds.',
    h('div', form, h('div.auth-alt', h('span.muted', 'Already have an account? '), h('a', { href: '#/login' }, 'Sign in'))), {
      aside: {
        eyebrow: 'Join this library',
        title: 'A shelf of your own.',
        text: 'Your account comes with its own space on this server, and everything you read stays yours.',
        points: [
          ['folder_special', 'Your own libraries', 'Books, Comics and Manga folders, ready for uploads and downloads.'],
          ['bookmarks', 'Your own progress', 'Bookmarks, highlights, notes and collections that only you see.'],
          ['local_fire_department', 'Streaks & goals', 'Set a yearly goal and watch your reading streak grow.'],
          ['devices', 'On every device', 'Install it on your phone’s Home Screen like an app.'],
        ],
      },
    });
  view.append(root);
  user.input.focus();
}
