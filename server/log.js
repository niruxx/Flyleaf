'use strict';

// Quiet, levelled logging. The terminal only gets concise lines (startup, scan
// summaries, real errors); everything is also appended to data/logs/flyleaf.log
// so a busy library scan doesn't flood the console.

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const consoleLevel = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

const logDir = path.join(config.dataDir, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'flyleaf.log');

// Rotate once at startup if the file has grown past 5 MB.
try {
  if (fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, `${logFile}.1`);
} catch {}
const stream = fs.createWriteStream(logFile, { flags: 'a' });

function write(level, scope, args) {
  const msg = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  stream.write(`${line}\n`);
  if (LEVELS[level] >= consoleLevel) {
    const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    out.write(`[${scope}] ${msg}\n`);
  }
}

function logger(scope) {
  return {
    debug: (...a) => write('debug', scope, a),
    info: (...a) => write('info', scope, a),
    warn: (...a) => write('warn', scope, a),
    error: (...a) => write('error', scope, a),
    /** Written to the log file only, never the console. */
    file: (...a) => stream.write(`${new Date().toISOString()} DEBUG [${scope}] ${a.join(' ')}\n`),
  };
}

/** Run fn with console.log/warn/info silenced (third-party libraries that print noise). */
async function quietly(fn) {
  const saved = { log: console.log, warn: console.warn, info: console.info };
  console.log = console.warn = console.info = (...a) => stream.write(`${new Date().toISOString()} LIB   ${a.join(' ')}\n`);
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

module.exports = { logger, quietly, logFile };
