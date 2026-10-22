'use strict';

// The built-in extension runtime. Mihon/Tachiyomi extensions are Android apps, which
// Suwayomi-Server can run on a normal computer. Instead of asking people to run it
// themselves, Flyleaf downloads Suwayomi-Server and a Java runtime into its data folder,
// runs it in the background on 127.0.0.1, and points the "mihon" plugin at it.
//
//   data/suwayomi/Suwayomi-Server.jar   the server
//   data/suwayomi/jre/                  Java (Eclipse Temurin, from Adoptium)
//   data/suwayomi/data/                 Suwayomi's own data: installed extensions, settings
//   data/suwayomi/suwayomi.log          its output

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');
const config = require('../config');
const settings = require('../settings');
const { q } = require('../db');
const runtime = require('./runtime');
const log = require('../log').logger('extensions');

const DIR = path.join(config.dataDir, 'suwayomi');
const JAR = path.join(DIR, 'Suwayomi-Server.jar');
const JRE_DIR = path.join(DIR, 'jre');
const ROOT_DIR = path.join(DIR, 'data');
const TMP_DIR = path.join(DIR, 'tmp');
const LOG_FILE = path.join(DIR, 'suwayomi.log');
const RELEASES = 'https://api.github.com/repos/Suwayomi/Suwayomi-Server/releases/latest';
const JAVA_FEATURE = 21; // Suwayomi-Server needs Java 21 or newer
const PLUGIN_ID = 'mihon';
const SETTINGS_KEY = 'extensionRuntime';
const DEFAULTS = { enabled: false, port: null, heapMb: null, version: null, java: null, javaBin: null };
const START_TIMEOUT = 5 * 60_000; // the first start sets up Suwayomi's database

const err = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const conf = () => ({ ...DEFAULTS, ...(settings.get(SETTINGS_KEY) || {}) });
const save = (patch) => settings.set(SETTINGS_KEY, { ...conf(), ...patch });

// The server process: stopped | starting | running | stopping. status() reports “installing” while
// a setup/update job runs and “absent” when nothing is installed.
const state = { phase: 'stopped', step: null, received: 0, total: null, error: null, startedAt: null };
let child = null;
let stopping = false;
let job = null;
let crashes = [];
const lines = [];

function javaPath() {
  const rel = conf().javaBin;
  const full = rel && path.join(JRE_DIR, rel);
  return full && fs.existsSync(full) ? full : null;
}
const installed = () => fs.existsSync(JAR) && Boolean(javaPath());
const baseUrl = (port = conf().port) => `http://127.0.0.1:${port}`;

// ---------------------------------------------------------------------------
// Downloading

/** Adoptium's names for this machine. */
function platform() {
  const os = { linux: 'linux', darwin: 'mac', win32: 'windows' }[process.platform];
  const arch = { x64: 'x64', arm64: 'aarch64', arm: 'arm', ppc64: 'ppc64le', s390x: 's390x' }[process.arch];
  if (!os || !arch) throw err(`The extension runtime isn’t available for ${process.platform}/${process.arch}.`);
  // musl (Alpine) Linux needs its own Java build.
  const musl = os === 'linux' && !process.report?.getReport?.().header?.glibcVersionRuntime;
  return { os: musl ? 'alpine-linux' : os, arch };
}

async function getJson(url) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': runtime.USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw err(`Can’t reach ${new URL(url).host}. Check the server’s internet connection.`, 502);
  }
  if (!res.ok) throw err(`${new URL(url).host} returned HTTP ${res.status}.`, 502);
  return res.json();
}

/** The newest Suwayomi-Server release: its .jar and checksum. */
async function latestRelease() {
  const r = await getJson(RELEASES);
  const jar = (r.assets || []).find((a) => /^Suwayomi-Server-v?[\d.]+\.jar$/i.test(a.name));
  if (!jar) throw err('The latest Suwayomi-Server release has no .jar to download.', 502);
  let sha256 = null;
  const sums = (r.assets || []).find((a) => /checksums/i.test(a.name));
  if (sums) {
    try {
      const text = await (await fetch(sums.browser_download_url, { headers: { 'User-Agent': runtime.USER_AGENT }, signal: AbortSignal.timeout(30_000) })).text();
      sha256 = text.split('\n').map((l) => l.trim().split(/\s+\*?/)).find(([, name]) => name === jar.name)?.[0] || null;
    } catch {}
  }
  return { version: r.tag_name, url: jar.browser_download_url, size: jar.size, sha256 };
}

/** The newest Java runtime for this machine from Adoptium (Eclipse Temurin). */
async function latestJre() {
  const { os, arch } = platform();
  const list = await getJson(`https://api.adoptium.net/v3/assets/latest/${JAVA_FEATURE}/hotspot?architecture=${arch}&image_type=jre&os=${os}&vendor=eclipse`);
  const pkg = list?.[0]?.binary?.package;
  if (!pkg?.link) throw err(`No Java ${JAVA_FEATURE} runtime is published for ${os}/${arch}.`, 502);
  return { release: list[0].release_name, url: pkg.link, size: pkg.size, sha256: pkg.checksum, name: pkg.name };
}

async function download(url, dest, { step, size, sha256 }) {
  Object.assign(state, { step, received: 0, total: size || null });
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': runtime.USER_AGENT }, signal: AbortSignal.timeout(60 * 60_000) });
  } catch {
    throw err(`Couldn’t download ${path.basename(dest)}. Check the server’s internet connection.`, 502);
  }
  if (!res.ok || !res.body) throw err(`Download failed (HTTP ${res.status}): ${url}`, 502);
  state.total = Number(res.headers.get('content-length')) || state.total;
  const hash = crypto.createHash('sha256');
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      state.received += chunk.length;
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(dest));
  if (sha256 && hash.digest('hex') !== sha256.toLowerCase()) {
    await fsp.rm(dest, { force: true });
    throw err(`${path.basename(dest)} arrived damaged (checksum mismatch). Try again.`, 502);
  }
}

/** Unpack a .tar.gz (or, on Windows, a .zip) with the system's tar. */
async function extract(archive, dest) {
  await fsp.mkdir(dest, { recursive: true });
  try {
    await promisify(execFile)('tar', ['-xf', archive, '-C', dest], { maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    if (e.code === 'ENOENT') throw err('Unpacking Java needs the “tar” command, which isn’t installed on the server.');
    throw err(`Couldn’t unpack Java: ${String(e.stderr || e.message).slice(0, 300)}`, 500);
  }
}

/** Find bin/java inside an unpacked JRE (macOS builds nest it in Contents/Home). */
async function findJava(dir, depth = 0) {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const direct = path.join(dir, 'bin', exe);
  if (fs.existsSync(direct)) return direct;
  if (depth >= 4) return null;
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const found = await findJava(path.join(dir, e.name), depth + 1);
    if (found) return found;
  }
  return null;
}

/** Download (or update) Suwayomi-Server and Java in the background, then start it. Poll status() for progress. */
function install() {
  if (job) return;
  platform(); // fail fast on unsupported machines
  state.error = null;
  job = (async () => {
    try {
      await fsp.rm(TMP_DIR, { recursive: true, force: true });
      await fsp.mkdir(TMP_DIR, { recursive: true });
      state.step = 'Checking for the latest version';
      const [release, jre] = await Promise.all([latestRelease(), latestJre()]);
      const c = conf();
      const needJre = c.java !== jre.release || !javaPath();
      const needJar = c.version !== release.version || !fs.existsSync(JAR);
      let javaBin = c.javaBin;
      if (needJre) {
        const archive = path.join(TMP_DIR, jre.name || 'jre.tar.gz');
        await download(jre.url, archive, { step: `Downloading Java ${JAVA_FEATURE}`, size: jre.size, sha256: jre.sha256 });
        state.step = 'Unpacking Java';
        await extract(archive, path.join(TMP_DIR, 'jre'));
        const java = await findJava(path.join(TMP_DIR, 'jre'));
        if (!java) throw err('The Java download didn’t contain a java program.', 502);
        javaBin = path.relative(path.join(TMP_DIR, 'jre'), java);
      }
      if (needJar) await download(release.url, path.join(TMP_DIR, 'server.jar'), { step: `Downloading Suwayomi-Server ${release.version}`, size: release.size, sha256: release.sha256 });

      // Swap the new files in while the server is stopped.
      state.step = 'Installing';
      if (needJre || needJar) await stop();
      if (needJre) {
        await fsp.rm(JRE_DIR, { recursive: true, force: true });
        await fsp.rename(path.join(TMP_DIR, 'jre'), JRE_DIR);
      }
      if (needJar) await fsp.rename(path.join(TMP_DIR, 'server.jar'), JAR);
      await fsp.rm(TMP_DIR, { recursive: true, force: true });
      save({ enabled: true, version: release.version, java: jre.release, javaBin });
      if (needJre || needJar) log.info(`Extension runtime installed: Suwayomi-Server ${release.version}, Java ${jre.release}`);
      return true;
    } catch (e) {
      state.error = e.message;
      log.warn(`Extension runtime setup failed: ${e.message}`);
      await fsp.rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
    } finally {
      state.step = null;
      job = null;
    }
  })().then((ok) => ok && !child && start()).catch((e) => {
    state.error = e.message;
  });
}

let updateCache = null;
/** Whether a newer Suwayomi-Server is out (checked at most every 6 hours). */
async function checkUpdate({ force = false } = {}) {
  if (force || !updateCache || Date.now() - updateCache.at > 6 * 3600_000) {
    const release = await latestRelease();
    updateCache = { at: Date.now(), latest: release.version };
  }
  const current = conf().version;
  return { current, latest: updateCache.latest, update: Boolean(current && updateCache.latest && current !== updateCache.latest) };
}

// ---------------------------------------------------------------------------
// Running

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** Keep the same port across restarts when possible; avoid 4567, where a separate Suwayomi usually runs. */
async function pickPort(current) {
  if (current && (await portFree(current))) return current;
  for (let p = 4580; p < 4600; p++) if (await portFree(p)) return p;
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function remember(chunk) {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line.trim()) continue;
    lines.push(line.slice(0, 1000));
    if (lines.length > 300) lines.shift();
  }
}

async function start() {
  if (child) return;
  if (job) throw err('Wait for the setup to finish.');
  if (!installed()) throw err('Set up the extension runtime first.');
  const c = conf();
  const port = await pickPort(c.port);
  if (port !== c.port) save({ port });
  await fsp.mkdir(ROOT_DIR, { recursive: true });
  // Start a fresh log once it gets big.
  try {
    if ((await fsp.stat(LOG_FILE)).size > 5 * 1024 * 1024) await fsp.rm(LOG_FILE);
  } catch {}
  const out = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  out.on('error', () => {});
  const P = '-Dsuwayomi.tachidesk.config.server.';
  const args = [
    '-Djava.awt.headless=true',
    // Keep everything inside data/suwayomi (the service user's home may be read-only).
    `-Duser.home=${DIR}`,
    `-Djava.util.prefs.userRoot=${path.join(DIR, 'prefs')}`,
    ...(c.heapMb ? [`-Xmx${c.heapMb}m`] : []),
    `${P}rootDir=${ROOT_DIR}`,
    // Only Flyleaf talks to it, so it listens on this machine alone.
    `${P}ip=127.0.0.1`,
    `${P}port=${port}`,
    `${P}webUIEnabled=false`,
    // Otherwise it downloads an embedded Chromium, which can't start on a server without a screen.
    `${P}kcefEnabled=false`,
    `${P}initialOpenInBrowserEnabled=false`,
    `${P}systemTrayEnabled=false`,
    '-jar', JAR,
  ];
  // Don't hand Flyleaf's own environment (SMTP settings etc.) to the child.
  const env = process.platform === 'win32'
    ? { ...process.env, HOME: DIR }
    : Object.fromEntries(Object.entries({ PATH: process.env.PATH || '/usr/bin:/bin', HOME: DIR, LANG: process.env.LANG || 'C.UTF-8', TZ: process.env.TZ }).filter(([, v]) => v));
  stopping = false;
  lines.length = 0;
  Object.assign(state, { phase: 'starting', error: null, startedAt: Date.now() });
  out.write(`\n--- Started by Flyleaf ${new Date().toISOString()} on port ${port} ---\n`);
  const proc = spawn(javaPath(), args, { cwd: DIR, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child = proc;
  for (const stream of [proc.stdout, proc.stderr]) {
    stream.on('data', remember);
    stream.pipe(out, { end: false });
  }
  proc.on('error', (e) => {
    state.error = `Couldn’t start Java: ${e.message}`;
  });
  proc.on('exit', (code, signal) => onExit(proc, code, signal, out));
  log.info(`Starting the extension runtime on ${baseUrl(port)}`);
  connectWhenReady(proc, port);
}

async function connectWhenReady(proc, port) {
  const until = Date.now() + START_TIMEOUT;
  while (child === proc && Date.now() < until) {
    try {
      const r = await fetch(`${baseUrl(port)}/api/v1/settings/about`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        if (child !== proc) return;
        state.phase = 'running';
        crashes = [];
        await connectPlugin(port).catch((e) => {
          state.error = `Running, but the Mihon extensions plugin couldn’t be set up: ${e.message}`;
        });
        log.info('Extension runtime is running');
        return;
      }
    } catch {}
    await sleep(1500);
  }
  if (child === proc) {
    await stop();
    state.error = 'The extension runtime didn’t start within 5 minutes. Its log may say why.';
  }
}

/** Install the Mihon extensions plugin if needed and point it at the managed server. */
async function connectPlugin(port) {
  const manager = require('./manager');
  if (!q('SELECT 1 FROM plugins WHERE id = ?').get(PLUGIN_ID)) await manager.installFromCatalog(PLUGIN_ID);
  manager.saveSettings(PLUGIN_ID, { url: baseUrl(port), username: '', password: '' });
  q('UPDATE plugins SET enabled = 1 WHERE id = ?').run(PLUGIN_ID);
  manager.refreshSources(PLUGIN_ID);
}

function onExit(proc, code, signal, out) {
  if (child !== proc) return;
  child = null;
  out.end();
  state.phase = 'stopped';
  if (stopping) {
    stopping = false;
    return;
  }
  state.error = `The extension runtime stopped unexpectedly (${signal || `exit code ${code}`}).${lines.length ? ` Last output: ${lines.slice(-3).join(' ').slice(-300)}` : ''}`;
  log.warn(state.error);
  // Restart after a crash, but give up if it keeps crashing.
  const now = Date.now();
  crashes = crashes.filter((t) => now - t < 10 * 60_000).concat(now);
  if (conf().enabled && crashes.length <= 3) {
    setTimeout(() => {
      if (!child && !job && conf().enabled) start().catch((e) => (state.error = e.message));
    }, 5000).unref();
  }
}

function stop() {
  const proc = child;
  if (!proc) return Promise.resolve();
  stopping = true;
  state.phase = 'stopping';
  return new Promise((resolve) => {
    const kill = setTimeout(() => proc.kill('SIGKILL'), 15_000);
    proc.once('exit', () => {
      clearTimeout(kill);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

async function restart() {
  await stop();
  await start();
}

/** Turn it on/off (also whether it starts with Flyleaf) and set its memory limit. */
async function configure({ enabled, heapMb } = {}) {
  if (heapMb !== undefined) {
    const v = heapMb === null || heapMb === '' ? null : Number(heapMb);
    if (v !== null && !(Number.isInteger(v) && v >= 256 && v <= 16384)) throw err('Memory limit must be between 256 and 16384 MB.');
    const changed = v !== conf().heapMb;
    save({ heapMb: v });
    if (changed && child) await restart();
  }
  if (enabled !== undefined) {
    save({ enabled: Boolean(enabled) });
    if (enabled) await start();
    else await stop();
  }
  return status();
}

/** Remove the runtime; `keepData` keeps installed extensions for a later reinstall. */
async function uninstall({ keepData = true } = {}) {
  if (job) throw err('Wait for the setup to finish.');
  await stop();
  for (const p of [JAR, JRE_DIR, TMP_DIR, path.join(DIR, 'prefs'), LOG_FILE]) await fsp.rm(p, { recursive: true, force: true });
  if (!keepData) await fsp.rm(DIR, { recursive: true, force: true });
  const { port } = conf();
  settings.set(SETTINGS_KEY, { ...DEFAULTS, port });
  // The plugin would only point at a server that's gone.
  const p = q('SELECT settings FROM plugins WHERE id = ?').get(PLUGIN_ID);
  if (p && String(JSON.parse(p.settings || '{}').url || '').startsWith(baseUrl(port))) {
    q('UPDATE plugins SET enabled = 0 WHERE id = ?').run(PLUGIN_ID);
    require('./manager').refreshSources(PLUGIN_ID);
  }
  state.error = null;
  lines.length = 0;
  log.info(`Extension runtime removed${keepData ? ' (extensions kept)' : ''}`);
}

function status() {
  const c = conf();
  const has = installed();
  return {
    installed: has,
    enabled: c.enabled,
    phase: job ? 'installing' : !has && state.phase === 'stopped' ? 'absent' : state.phase,
    step: state.step,
    received: state.received,
    total: state.total,
    error: state.error,
    version: c.version,
    java: c.java,
    port: c.port,
    url: c.port ? baseUrl(c.port) : null,
    heapMb: c.heapMb,
    startedAt: child ? state.startedAt : null,
  };
}

/** Recent output, from memory or (after a Flyleaf restart) the end of the log file. */
async function logTail() {
  if (lines.length) return lines.join('\n');
  try {
    const fh = await fsp.open(LOG_FILE);
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return '';
  }
}

/** Start with Flyleaf when it's turned on. */
function boot() {
  if (conf().enabled && installed()) start().catch((e) => {
    state.error = e.message;
    log.warn(`Couldn’t start the extension runtime: ${e.message}`);
  });
}

/** Stop the child with Flyleaf. */
function shutdown() {
  if (!child) return;
  stopping = true;
  child.kill('SIGTERM');
}
process.on('exit', () => child?.kill());

module.exports = { status, install, checkUpdate, start, stop, restart, configure, uninstall, logTail, boot, shutdown };
