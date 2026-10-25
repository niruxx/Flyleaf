import { api } from '../api.js';
import { session, navigate } from '../router.js';
import { h, icon, field, button, formError } from '../ui.js';
import { afterSignIn } from '../shell.js';
import { onboardFrame, STEPS } from './welcome.js';

function shell(title, subtitle, form) {
  return h(
    'div.auth',
    h('div.auth-card', h('div.logo', icon('auto_stories', 'filled')), h('h1.headline-medium', title), h('p.body-medium.muted', { style: { marginTop: '8px' } }, subtitle), form),
  );
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
  const submit = button('Sign in', { type: 'submit' });

  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.replaceChildren();
        submit.disabled = true;
        try {
          const { user: u } = await api.login({ username: user.input.value.trim(), password: pass.input.value });
          session.user = u;
          afterSignIn();
          const next = sessionStorage.getItem('flyleaf.after-login');
          sessionStorage.removeItem('flyleaf.after-login');
          navigate(next && next !== '/login' && next !== '/setup' ? next : '/', { replace: true });
        } catch (e2) {
          err.append(formError(e2.message));
          submit.disabled = false;
          pass.input.select();
        }
      },
    },
    err,
    user,
    pass,
    submit,
  );
  // "Create an account" only when the admin has turned sign-up on.
  const signup = h('div.auth-alt');
  api.status().then((st) => {
    if (st.registration) signup.append(h('span.muted', 'New here? '), h('a', { href: '#/register' }, 'Create an account'));
  }).catch(() => {});
  view.append(shell('Flyleaf', 'Sign in to your library.', h('div', form, signup)));
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
  const form = h(
    'form',
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
          const { user: u } = await api.register({
            username: user.input.value.trim(),
            password: pass.input.value,
            displayName: name.input.value,
            inviteCode: invite ? invite.input.value.trim() : undefined,
          });
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
    name,
    user,
    pass,
    pass2,
    invite,
    submit,
  );
  view.append(shell('Create your account', 'You get your own Books, Comics and Manga libraries, plus your own progress, bookmarks and collections.',
    h('div', form, h('div.auth-alt', h('span.muted', 'Already have an account? '), h('a', { href: '#/login' }, 'Sign in')))));
  user.input.focus();
}
