'use strict';
// Usage: npm run reset-password -- <username> <new-password>
const { q } = require('../server/db');
const { hashPassword, validatePassword } = require('../server/auth');

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.log('Usage: npm run reset-password -- <username> <new-password>');
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
q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
q('DELETE FROM sessions WHERE user_id = ?').run(user.id);
console.log(`Password for ${username} updated. Existing sessions were signed out.`);
