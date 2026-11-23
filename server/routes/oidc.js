'use strict';

const express = require('express');
const { randomBytes } = require('node:crypto');
const { q, tx } = require('../db');
const auth = require('../auth');
const log = require('../log').logger('oidc');

const router = express.Router();
const cookieName = '__Host-flyleaf_oidc';
const COOKIE_AGE = 600;
const pending = new Map();

function httpsUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search) return url;
  } catch {}
  return null;
}

const issuer = httpsUrl(process.env.OIDC_ISSUER);
const site = httpsUrl(process.env.OIDC_BASE_URL);
const clientId = process.env.OIDC_CLIENT_ID?.trim();
const clientSecret = process.env.OIDC_CLIENT_SECRET;
const configured = Boolean(issuer && clientId && site?.pathname === '/');
const endpoint = (action) => new URL(`/api/oidc/${action}`, site);
const loginUrl = () => configured ? endpoint('login').href : null;

let discovery;
function discover(client) {
  const authenticate = clientSecret ? (provider, ...args) => {
    const methods = provider.token_endpoint_auth_methods_supported;
    const postOnly = methods?.includes('client_secret_post') && !methods.includes('client_secret_basic');
    const secret = postOnly ? client.ClientSecretPost : client.ClientSecretBasic;
    return secret(clientSecret)(provider, ...args);
  } : client.None();
  discovery ||= client.discovery(issuer, clientId, clientSecret, authenticate,
    { execute: [client.enableNonRepudiationChecks] }).catch((error) => {
    discovery = null;
    throw error;
  });
  return discovery;
}

function cookie(res, value, age) {
  res.append('Set-Cookie', `${cookieName}=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`);
}

function browserToken(req) {
  return req.get('cookie')?.match(/(?:^|;\s*)__Host-flyleaf_oidc=([\w-]{43})(?:;|$)/)?.[1];
}

async function begin(res, userId = null) {
  const client = require('openid-client');
  const config = await discover(client);
  const state = client.randomState();
  const nonce = client.randomNonce();
  const verifier = client.randomPKCECodeVerifier();
  const browser = randomBytes(32).toString('base64url');
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: endpoint('callback').href,
    scope: 'openid profile',
    code_challenge_method: 'S256',
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    state, nonce,
  });
  const now = Date.now();
  for (const [key, value] of pending) if (value.expires <= now) pending.delete(key);
  if (pending.size >= 500) pending.delete(pending.keys().next().value);
  pending.set(state, { nonce, verifier, browser, userId, expires: now + COOKIE_AGE * 1000 });
  cookie(res, browser, COOKIE_AGE);
  return url.href;
}

function ready() {
  return configured && Boolean(q('SELECT 1 FROM users LIMIT 1').get());
}

router.get('/oidc/login', async (req, res) => {
  if (!ready()) return res.status(404).json({ error: 'OpenID Connect is unavailable.' });
  try {
    res.redirect(await begin(res));
  } catch (e) {
    log.warn(`OIDC discovery failed: ${e.code || e.name}`);
    res.redirect(new URL('/#/login?oidc=failed', site).href);
  }
});

router.post('/oidc/link', auth.requireUser, async (req, res) => {
  if (!ready() || req.user.apiKey) return res.status(403).json({ error: 'OpenID Connect linking is unavailable.' });
  if (req.get('origin') !== site.origin) return res.status(400).json({ error: 'Open Flyleaf at its configured OpenID Connect address to link your account.' });
  try {
    res.json({ url: await begin(res, req.user.id) });
  } catch (e) {
    log.warn(`OIDC linking failed: ${e.code || e.name}`);
    res.status(502).json({ error: 'Could not connect to the OpenID provider.' });
  }
});

router.post('/oidc/totp', (req, res) => {
  if (!ready() || req.get('origin') !== site.origin || req.get('X-Flyleaf') !== '1') return res.status(403).end();
  const key = browserToken(req);
  const attempt = pending.get(key);
  res.set('Cache-Control', 'no-store');
  if (!attempt?.secondFactor || attempt.expires <= Date.now()) return res.status(410).json({ error: 'Sign in with OpenID Connect again.' });
  const user = q('SELECT * FROM users WHERE id = ?').get(attempt.userId);
  const step = require('../totp').verify(user?.totp_secret, req.body?.code, user?.totp_step);
  if (step == null) {
    if (++attempt.failures >= 5) { pending.delete(key); cookie(res, '', 0); }
    return res.status(401).json({ error: 'Invalid or already used authenticator code.' });
  }
  pending.delete(key);
  cookie(res, '', 0);
  q('UPDATE users SET totp_step = ?, last_seen_at = ? WHERE id = ?').run(step, Date.now(), user.id);
  auth.destroySession(req, res);
  auth.createSession(res, user.id, req.get('user-agent'));
  const signedIn = auth.toUser(user);
  res.json({ user: { ...require('./auth').publicUser(signedIn), backgroundUrl: signedIn.backgroundUrl } });
});

function account(claims, linkUser) {
  return tx(() => {
    const adminGroup = process.env.OIDC_ADMIN_GROUP?.trim();
    const role = adminGroup && Array.isArray(claims.groups) && claims.groups.includes(adminGroup) ? 'admin' : 'guest';
    const existing = q('SELECT user_id, managed_role FROM oidc_identities WHERE issuer = ? AND subject = ?').get(claims.iss, claims.sub);
    if (existing) {
      if (linkUser && existing.user_id !== linkUser) throw new Error('Identity already linked.');
      if (!linkUser && existing.managed_role) q('UPDATE users SET role = ? WHERE id = ?').run(role, existing.user_id);
      return existing.user_id;
    }
    if (!linkUser && process.env.OIDC_ALLOW_SIGNUP === 'false') throw new Error('OIDC account creation is disabled.');
    let id = linkUser;
    if (!id) {
      const username = `oidc_${randomBytes(9).toString('hex')}`;
      const name = [claims.name, claims.preferred_username].find((value) => typeof value === 'string' && value.trim());
      const libraries = process.env.OIDC_SHARED_LIBRARIES === 'all' ? null : '[]';
      const password = auth.hashPassword(randomBytes(32).toString('base64url'));
      id = Number(q(`INSERT INTO users (username, display_name, password_hash, role, library_ids, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(username, name?.trim().slice(0, 64) || null, password, role, libraries, Date.now()).lastInsertRowid);
    }
    q('INSERT INTO oidc_identities (issuer, subject, user_id, managed_role) VALUES (?, ?, ?, ?)').run(claims.iss, claims.sub, id, !linkUser && adminGroup ? 1 : 0);
    return id;
  });
}

router.get('/oidc/callback', async (req, res) => {
  if (!ready()) return res.status(404).end();
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const attempt = pending.get(state);
  const browser = browserToken(req);
  const linkPath = '/#/settings/account?oidc=';
  let destination = '/#/login?oidc=failed';
  try {
    if (!attempt?.browser || attempt.expires <= Date.now() || attempt.browser !== browser) throw new Error('Invalid login attempt.');
    pending.delete(state);
    cookie(res, '', 0);
    if (attempt.userId && (req.user?.id !== attempt.userId || req.user.apiKey)) throw new Error('Sign-in changed during linking.');
    if (attempt.userId) destination = linkPath + 'failed';
    const client = require('openid-client');
    const callback = endpoint('callback');
    callback.search = new URL(req.originalUrl, site).search;
    const response = await client.authorizationCodeGrant(await discover(client), callback, {
      expectedState: state, expectedNonce: attempt.nonce, pkceCodeVerifier: attempt.verifier,
    });
    const claims = response.claims();
    if (!claims?.iss || typeof claims.sub !== 'string' || !claims.sub) throw new Error('Invalid identity.');
    const id = account(claims, attempt.userId);
    if (!attempt.userId && q('SELECT totp_secret FROM users WHERE id = ?').get(id)?.totp_secret) {
      const token = randomBytes(32).toString('base64url');
      pending.set(token, { secondFactor: true, userId: id, failures: 0, expires: Date.now() + 300_000 });
      cookie(res, token, 300);
      return res.set('Referrer-Policy', 'no-referrer').redirect(new URL('/#/login?oidc=authenticator', site).href);
    }
    q('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
    if (!attempt.userId) {
      auth.destroySession(req, res);
      auth.createSession(res, id, req.get('user-agent'));
      destination = '/#/login';
    } else {
      destination = linkPath + 'linked';
    }
  } catch (e) {
    log.warn(`OIDC sign-in failed: ${e.code || e.name}`);
  }
  res.set('Referrer-Policy', 'no-referrer').redirect(new URL(destination, site).href);
});

module.exports = { router, loginUrl };
