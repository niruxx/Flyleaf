import { api } from '../api.js';
import { session, navigate } from '../router.js';
import { h, icon, field, button, formError } from '../ui.js';

function shell(title, subtitle, form) {
  return h(
    'div.auth',
    h('div.auth-card', h('div.logo', icon('auto_stories', 'filled')), h('h1.headline-medium', title), h('p.body-medium.muted', { style: { marginTop: '8px' } }, subtitle), form),
  );
}

export function setupView(view) {
  const name = field('Your name', { autocomplete: 'name', support: 'Shown in the app. Optional.' });
  const user = field('Admin username', { autocomplete: 'username', required: true, support: '3–32 letters, numbers, . - _' });
  const pass = field('Password', { type: 'password', autocomplete: 'new-password', required: true, support: 'At least 8 characters.' });
  const pass2 = field('Confirm password', { type: 'password', autocomplete: 'new-password', required: true });
  const err = h('div');
  const submit = button('Create admin account', { type: 'submit', icon: 'arrow_forward' });

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
          const { user: u } = await api.setup({ username: user.input.value.trim(), password: pass.input.value, displayName: name.input.value });
          session.user = u;
          sessionStorage.setItem('flyleaf.welcome', '1');
          navigate('/settings', { replace: true });
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
    submit,
  );

  view.append(
    shell(
      'Welcome to Flyleaf',
      'Create the admin account. You’ll use it to add library folders and invite read-only guests.',
      form,
    ),
  );
  user.input.focus();
}

export function loginView(view) {
  const user = field('Username', { autocomplete: 'username', required: true, autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false' });
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
  view.append(shell('Flyleaf', 'Sign in to your library.', form));
  user.input.focus();
}
