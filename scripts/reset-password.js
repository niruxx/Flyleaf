'use strict';
// Usage: npm run reset-password -- <username> <new-password>
const { q, tx } = require('../server/db');
const { hashPassword, validatePassword } = require('../server/auth');

const [username, password, option] = process.argv.slice(2);
if (!username || !password || (option && option !== '--clear-totp')) {
  console.log('Usage: npm run reset-password -- <username> <new-password> [--clear-totp]');
  const users = q('SELECT username, role FROM users ORDER BY role, username').all();
  if (users.length) console.log(`Users: ${users.map((u) => `${u.username} (${u.role})`).join(', ')}`);
  process.exit(1);
}
const err = validatePassword(password);
if (err) {
  console.error(err);
  process.exit(1);
}
const user = q('SELECT id FROM users WHERE username = ?').get(username);
if (!user) {
  console.error(`No user named "${username}".`);
  process.exit(1);
}
const hash = hashPassword(password);
tx(() => {
  q('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  if (option === '--clear-totp') q('UPDATE users SET totp_secret = NULL, totp_step = NULL WHERE id = ?').run(user.id);
  q('DELETE FROM sessions WHERE user_id = ?').run(user.id);
});
console.log(`Password for ${username} updated. Existing sessions were signed out.`);
