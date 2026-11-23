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

function account(claims, linkUser) {
  return tx(() => {
    const existing = q('SELECT user_id FROM oidc_identities WHERE issuer = ? AND subject = ?').get(claims.iss, claims.sub);
    if (existing) {
      if (linkUser && existing.user_id !== linkUser) throw new Error('Identity already linked.');
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
        VALUES (?, ?, ?, 'guest', ?, ?)`).run(username, name?.trim().slice(0, 64) || null, password, libraries, Date.now()).lastInsertRowid);
    }
    q('INSERT INTO oidc_identities (issuer, subject, user_id) VALUES (?, ?, ?)').run(claims.iss, claims.sub, id);
    return id;
  });
}

router.get('/oidc/callback', async (req, res) => {
  if (!ready()) return res.status(404).end();
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const attempt = pending.get(state);
  const browser = req.get('cookie')?.match(/(?:^|;\s*)__Host-flyleaf_oidc=([\w-]{43})(?:;|$)/)?.[1];
  const linkPath = '/#/settings/account?oidc=';
  let destination = '/#/login?oidc=failed';
  try {
    if (!attempt || attempt.expires <= Date.now() || attempt.browser !== browser) throw new Error('Invalid login attempt.');
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
