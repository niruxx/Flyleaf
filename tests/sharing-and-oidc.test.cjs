const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

function load(file, modules, globals = {}) {
  const filename = path.resolve(file);
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, URL, process, ...globals,
    require: (name) => modules[name] ?? realRequire(name),
  }, { filename });
  return module.exports;
}

function database(t) {
  const db = load('server/db.js', {
    'node:sqlite': { DatabaseSync: class extends DatabaseSync { constructor() { super(':memory:'); } } },
    'node:fs': { mkdirSync() {} },
    './config': { dataDir: '.' },
  });
  t.after(() => db.db.close());
  db.db.exec(`
    INSERT INTO users (id, username, email, password_hash, role, created_at)
    VALUES (1, 'reader', 'reader@example.test', '', 'guest', 0), (2, 'other', NULL, '', 'guest', 0);
    INSERT INTO libraries (id, name, path, kind, created_at) VALUES (1, 'Library', 'books', 'books', 0);
    INSERT INTO books (id, library_id, path, rel_path, title, format, mtime, added_at, updated_at)
    VALUES (1, 1, 'books/one.epub', 'one.epub', 'First', 'epub', 25, 0, 0),
      (2, 1, 'books/two.cbz', 'two.cbz', 'Second', 'cbz', 26, 0, 0);
    INSERT INTO progress (user_id, book_id, position, percent, started_at, updated_at)
    VALUES (1, 1, 'private progress', 0.6, 0, 0);
  `);
  return db;
}

function request(router, method, url, { user, body, headers = {} } = {}) {
  const query = Object.fromEntries(new URL(url, 'https://books.example.test').searchParams);
  return new Promise((resolve, reject) => {
    const req = { method, url, originalUrl: '/api' + url, query, user, body, headers, protocol: 'https', get: (name) => headers[name] };
    const res = {
      code: 200, headers: {}, cookies: [],
      set(values, value) { Object.assign(this.headers, typeof values === 'string' ? { [values]: value } : values); return this; },
      append(name, value) { if (name === 'Set-Cookie') this.cookies.push(value); return this; },
      status(code) { this.code = code; return this; },
      json(data) { resolve({ ...this, data }); },
      redirect(destination) { resolve({ ...this, code: 302, destination }); },
      end() { resolve(this); },
    };
    router.handle(req, res, (error) => error ? reject(error) : resolve({ code: 404 }));
  });
}

test('guest links stay limited to the shared book, grant downloads explicitly, and stop working on expiry or revocation', async (t) => {
  const db = database(t);
  const auth = load('server/auth.js', { './db': db, './config': {} });
  const serialize = load('server/serialize.js', { './db': db });
  const user = auth.toUser(db.q('SELECT * FROM users WHERE id = 1').get());
  const other = auth.toUser(db.q('SELECT * FROM users WHERE id = 2').get());
  const { guest, manage } = load('server/routes/book-shares.js', {
    '../db': db, '../auth': auth, '../serialize': serialize, '../profiles': { DEFAULT_SETTINGS: {} },
    './books': {
      readable: (req, res) => serialize.getBook(req.params.id, req.user) || (res.status(404).end(), null),
      readerFile: (req, res, book, cache) => res.set('Cache-Control', cache).json({ asset: book.id }),
      originalFile: (req, res, book, options) => res.json({ original: book.id, scoped: options.scoped }),
      pageList: (req, res, book) => res.json({ pagesFor: book.id }),
    },
  });
  const newShare = (book, body) => request(manage, 'POST', `/books/${book}/shares`, { user, body });
  const tokenPath = (s) => '/' + s.data.path.split('/').at(-1);
  const locator = 'epubcfi(/6/4!/4/2/4)';
  const read = await newShare(1, { locator });
  const token = tokenPath(read);
  assert.equal(read.code, 201);
  assert.equal(db.q('SELECT token_hash FROM book_shares WHERE id = ?').get(read.data.id).token_hash.length, 64);
  const info = await request(guest, 'GET', token + '/reader');
  assert.equal(info.data.locator, locator);
  assert.equal(info.data.book.id, 1);
  assert.equal(info.data.book.progress, undefined);
  assert.equal(info.data.book.seriesId, undefined);
  assert.equal(info.data.allowDownload, false);
  assert.equal((await request(guest, 'GET', token + '/file')).data.asset, 1);
  assert.equal((await request(guest, 'GET', token + '/download')).code, 403);
  assert.equal((await request(guest, 'GET', token + '/books/2/file')).code, 404);
  assert.equal((await request(guest, 'PUT', token + '/progress')).code, 404);
  await request(manage, 'DELETE', '/book-shares/' + read.data.id, { user: other });
  assert.equal((await request(guest, 'GET', token + '/reader')).code, 200);
  await request(manage, 'DELETE', '/book-shares/' + read.data.id, { user });
  assert.equal((await request(guest, 'GET', token + '/reader')).code, 404);

  const comic = await newShare(2, { allowDownload: true, locator: '2', days: 1 });
  const comicPath = tokenPath(comic);
  assert.equal((await request(guest, 'GET', comicPath + '/pages')).data.pagesFor, 2);
  assert.equal((await request(guest, 'GET', comicPath + '/file')).code, 404);
  assert.equal((await request(guest, 'GET', comicPath + '/download')).data.original, 2);
  db.q('UPDATE books SET mtime = 40 WHERE id = 2').run();
  assert.equal((await request(guest, 'GET', comicPath + '/download')).code, 404);
  const expired = await newShare(2);
  db.q('UPDATE book_shares SET expires_at = 0 WHERE id = ?').run(expired.data.id);
  assert.equal((await request(guest, 'GET', tokenPath(expired) + '/reader')).code, 404);
  const disabled = await newShare(2);
  db.q('UPDATE users SET permissions = ? WHERE id = 1').run('{"download":false}');
  assert.equal((await request(guest, 'GET', tokenPath(disabled) + '/download')).code, 404);
});

test('OIDC binds callbacks to the initiating browser, separates identities from email, and links explicitly', async (t) => {
  const db = database(t);
  const exchanges = [];
  const sessions = [];
  let count = 0;
  let subject = 'one';
  let groups = ['flyleaf-admins'];
  const issuer = 'https://id.example.test';
  const auth = {
    requireUser: (req, res, next) => req.user ? next() : res.status(401).end(),
    hashPassword: () => 'random-password-hash',
    toUser: (row) => ({ id: row.id }),
    createSession: (res, id) => sessions.push(id),
    destroySession() {},
  };
  const client = {
    discovery: async () => ({}), None: () => () => {}, enableNonRepudiationChecks() {},
    randomState: () => `state-${++count}`, randomNonce: () => 'nonce',
    randomPKCECodeVerifier: () => 'verifier', calculatePKCECodeChallenge: async () => 'challenge',
    buildAuthorizationUrl: (config, params) => new URL('/authorize?' + new URLSearchParams(params), issuer),
    authorizationCodeGrant: (config, url, checks) => {
      exchanges.push({ url, checks });
      return { claims: () => ({ iss: issuer, sub: subject, email: 'reader@example.test', name: 'Reader', groups }) };
    },
  };
  const { router, loginUrl } = load('server/routes/oidc.js', {
    '../db': db, '../auth': auth, '../log': { logger: () => ({ warn() {} }) }, 'openid-client': client,
    './auth': { publicUser: (user) => user }, '../totp': { verify: (...args) => require('../server/totp').verify(...args, 59_000) },
  }, { process: { env: { OIDC_ISSUER: issuer, OIDC_BASE_URL: 'https://books.example.test', OIDC_CLIENT_ID: 'app', OIDC_ADMIN_GROUP: 'flyleaf-admins' } } });
  assert.equal(loginUrl(), 'https://books.example.test/api/oidc/login');
  const start = async (user) => {
    const res = user
      ? await request(router, 'POST', '/oidc/link', { user, headers: { origin: 'https://books.example.test' } })
      : await request(router, 'GET', '/oidc/login');
    const location = new URL(res.destination || res.data.url);
    assert.equal(location.searchParams.get('code_challenge'), 'challenge');
    return { cookie: res.cookies[0].split(';')[0], state: location.searchParams.get('state') };
  };
  const callback = ({ state, cookie }, user) => request(router, 'GET', `/oidc/callback?code=example&state=${state}`, { user, headers: { cookie } });
  const attempt = await start();
  assert.match((await callback({ ...attempt, cookie: '' })).destination, /oidc=failed$/);
  assert.equal(exchanges.length, 0);
  assert.match((await callback(attempt)).destination, /#\/login$/);
  assert.equal(exchanges[0].checks.expectedNonce, 'nonce');
  assert.equal(exchanges[0].checks.expectedState, attempt.state);
  assert.equal(exchanges[0].checks.pkceCodeVerifier, 'verifier');
  assert.deepEqual(sessions, [3]);
  assert.equal(db.q('SELECT role FROM users WHERE id = 3').get().role, 'admin');
  assert.equal(db.q('SELECT library_ids FROM users WHERE id = 3').get().library_ids, '[]');
  assert.match((await callback(attempt)).destination, /oidc=failed$/);
  groups = [];
  await callback(await start());
  assert.deepEqual(sessions, [3, 3]);
  assert.equal(db.q('SELECT role FROM users WHERE id = 3').get().role, 'guest');

  const local = { id: 1 };
  subject = 'two';
  groups = ['flyleaf-admins'];
  assert.match((await callback(await start(local), local)).destination, /oidc=linked$/);
  await callback(await start());
  assert.deepEqual(sessions, [3, 3, 1]);
  assert.equal(db.q('SELECT role FROM users WHERE id = 1').get().role, 'guest');
  db.q('UPDATE users SET totp_secret = ? WHERE id = 1').run('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  const secondFactor = await callback(await start());
  assert.match(secondFactor.destination, /oidc=authenticator$/);
  assert.deepEqual(sessions, [3, 3, 1]);
  const finish = (cookie, code) => request(router, 'POST', '/oidc/totp', { body: { code }, headers: { origin: 'https://books.example.test', 'X-Flyleaf': '1', cookie } });
  const cookie = secondFactor.cookies.at(-1).split(';')[0];
  assert.equal((await finish('', '287082')).code, 410);
  assert.equal((await finish(cookie, '000000')).code, 401);
  assert.equal((await finish(cookie, '287082')).data.user.id, 1);
  assert.equal((await finish(cookie, '287082')).code, 410);
  assert.deepEqual(sessions, [3, 3, 1, 1]);
});

test('admin authenticator enrollment gates local login, rejects replay and supports recovery', async (t) => {
  const db = database(t);
  const auth = load('server/auth.js', { './db': db, './config': {} }, { Buffer });
  const totp = require('../server/totp');
  const running = [];
  auth.createSession = (_, id) => running.push(id);
  const password = 'test-password';
  db.q("UPDATE users SET password_hash = ?, role = 'admin' WHERE id = 1").run(auth.hashPassword(password));
  const user = auth.toUser(db.q('SELECT * FROM users WHERE id = 1').get());
  let now = 59_000;
  const { router, me } = load('server/routes/auth.js', { '../db': db, '../auth': auth, '../config': {}, '../settings': {},
    '../totp': { ...totp, verify: (...args) => totp.verify(...args, now) } });
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totp.verify(secret, '287082', null, now), 1);
  const configure = (action, code) => request(me, 'POST', '/totp', { user, body: { action, password, code, secret } });
  const login = (code) => request(router, 'POST', '/login', { body: { username: 'reader', password, code } });
  assert.equal((await configure('enable', '287082')).data.enabled, true);
  assert.equal((await login()).code, 428);
  assert.equal((await login('287082')).code, 401);
  now = 1_111_111_109_000;
  assert.equal((await login('081804')).code, 200);
  assert.equal((await login('081804')).code, 401);
  load('scripts/reset-password.js', { '../server/db': db, '../server/auth': auth }, {
    process: { argv: ['node', 'reset-password.js', 'reader', password, '--clear-totp'], exit: (code) => { throw new Error(`Recovery exited ${code}`); } },
    console: { log() {} },
  });
  assert.equal((await login()).code, 200);
  assert.deepEqual(running, [1, 1]);
});

test('the OIDC client exchanges a PKCE code and validates a signed provider ID token', async (t) => {
  const db = database(t);
  const oidc = require('openid-client');
  const { exportJWK, generateKeyPair, SignJWT } = createRequire(require.resolve('openid-client'))('jose');
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const key = { ...await exportJWK(publicKey), kid: 'fixture-key', alg: 'ES256' };
  const issuer = 'https://id.example.test';
  let authRequest;
  let subject = 'signed-subject';
  let rejectSignature = false;
  const fetch = async (url, { body } = {}) => {
    if (url.toString() === issuer + '/.well-known/openid-configuration') return Response.json({
      issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token',
      jwks_uri: issuer + '/jwks', response_types_supported: ['code'], id_token_signing_alg_values_supported: ['ES256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
    if (url.toString() === issuer + '/jwks') return Response.json({ keys: [key] });
    assert.equal(url.toString(), issuer + '/token');
    assert.equal(body.get('code'), 'mock-code');
    assert.equal(await oidc.calculatePKCECodeChallenge(body.get('code_verifier')), authRequest.searchParams.get('code_challenge'));
    const pair = rejectSignature ? await generateKeyPair('ES256') : { privateKey };
    const idToken = await new SignJWT({ nonce: authRequest.searchParams.get('nonce') })
      .setProtectedHeader({ alg: 'ES256', kid: key.kid }).setIssuer(issuer).setAudience('flyleaf')
      .setSubject(subject).setIssuedAt().setExpirationTime('2m').sign(pair.privateKey);
    return Response.json({ access_token: 'fixture', token_type: 'Bearer', id_token: idToken });
  };
  const realClient = { ...oidc, discovery: (url, id, metadata, auth, options) =>
    oidc.discovery(url, id, metadata, auth, { ...options, [oidc.customFetch]: fetch }) };
  const sessions = [];
  const { router } = load('server/routes/oidc.js', {
    'openid-client': realClient, '../db': db,
    '../auth': { requireUser() {}, hashPassword: () => 'test', createSession: (res, id) => sessions.push(id), destroySession() {} },
    '../log': { logger: () => ({ warn() {} }) },
  }, { process: { env: { OIDC_ISSUER: issuer, OIDC_BASE_URL: 'https://books.example.test', OIDC_CLIENT_ID: 'flyleaf' } } });
  async function signIn() {
    const start = await request(router, 'GET', '/oidc/login');
    authRequest = new URL(start.destination);
    const cookie = start.cookies[0].split(';')[0];
    return request(router, 'GET', '/oidc/callback?code=mock-code&state=' + authRequest.searchParams.get('state'), { headers: { cookie } });
  }
  assert.match((await signIn()).destination, /#\/login$/);
  assert.equal(db.q('SELECT user_id FROM oidc_identities WHERE subject = ?').get(subject).user_id, 3);
  subject = 'bad-signature';
  rejectSignature = true;
  assert.match((await signIn()).destination, /oidc=failed$/);
  assert.deepEqual(sessions, [3]);
});

test('page highlights navigate to their page and reproject through crops', async () => {
  const source = fs.readFileSync('public/js/reader/page-annotations.js', 'utf8').replace(/^import .*\n/gm, '');
  const { pageFromLocator, visibleArea } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  assert.equal(pageFromLocator('7@0.2,0.3,0.1,0.1'), 7);
  assert.equal(pageFromLocator('0'), 0);
  assert.equal(pageFromLocator('epubcfi(/6/4)'), null);
  const crop = { x: 0.5, y: 0, w: 0.5, h: 1 };
  assert.equal(visibleArea({ x: 0, y: 0.25, w: 0.25, h: 0.25 }, crop), null);
  assert.deepEqual(visibleArea({ x: 0.25, y: 0.25, w: 0.5, h: 0.25 }, crop), { x: 0, y: 0.25, w: 0.5, h: 0.25 });
});

test('share addresses prefer the configured public address and distinguish a public IP from private addresses', async () => {
  let publicUrl = 'https://books.example.test/';
  const { router } = load('server/routes/profile.js', {
    'node:fs': { ...fs, mkdirSync() {} },
    'node:os': { networkInterfaces: () => ({ eth0: [{ address: '192.168.1.20', family: 'IPv4' }] }) },
    '../db': {}, '../settings': { get: () => publicUrl }, '../config': { dataDir: '.', host: '0.0.0.0', port: 7878 },
  });
  const info = async (host) => (await request(router, 'GET', '/share-info', { headers: { host } })).data;
  const configured = await info('192.168.1.20:7878');
  assert.equal(configured.public, 'https://books.example.test');
  assert.deepEqual(Array.from(configured.local), ['http://192.168.1.20:7878']);
  publicUrl = '';
  assert.equal((await info('192.168.1.20:7878')).public, null);
  assert.equal((await info('100.64.0.25:7878')).public, null);
  assert.equal((await info('8.8.8.8:7878')).public, 'https://8.8.8.8:7878');
});

test('SMTP delivery sends an image book as a CBZ with just its pages and keeps Kindle format validation', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyleaf-mail-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '01.jpg'), 'page bytes');
  fs.writeFileSync(path.join(dir, 'other.epub'), 'other book');
  const parts = load('server/book-package.js', { './archive': { listPages: async () => ['01.jpg'] } });
  const messages = [];
  const mail = load('server/mailer.js', {
    './book-package': parts,
    './settings': { get: () => ({ host: 'smtp.example.test', from: 'flyleaf@example.test' }) },
    nodemailer: { createTransport: () => ({ async sendMail(message) {
      const chunks = [];
      for await (const chunk of message.attachments[0].content) chunks.push(chunk);
      messages.push({ to: message.to.address, data: Buffer.concat(chunks) });
    } }) },
  }, { Buffer });
  const book = { path: dir, title: 'Comic', format: 'folder' };
  await assert.rejects(mail.sendBooks({ email: 'reader@kindle.com', platform: 'kindle' }, [book]), /Kindle only accepts/);
  assert.equal(await mail.sendBooks({ email: 'reader@example.test', platform: 'other' }, [book]), 1);
  const zip = await require('jszip').loadAsync(messages[0].data);
  assert.deepEqual(Object.keys(zip.files), ['01.jpg']);
  assert.equal(messages[0].to, 'reader@example.test');
});
