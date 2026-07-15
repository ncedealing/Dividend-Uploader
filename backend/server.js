'use strict';

require('dotenv').config();

const bcrypt = require('bcryptjs');
const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const app = express();
const PORT = Number(process.env.PORT || 3100);
const APP_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(APP_ROOT, 'local-data'));
const CONFIG_DIR = path.join(DATA_DIR, 'configs');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const JWT_SECRET_FILE = path.join(DATA_DIR, '.jwt_secret');
const UPGRADE_DIR = path.join(DATA_DIR, 'upgrades');
const UPGRADE_ZIP_FILE = path.join(UPGRADE_DIR, 'pending.zip');
const UPGRADE_READY_FILE = path.join(UPGRADE_DIR, 'pending.ready');
const UPGRADE_RESULT_FILE = path.join(UPGRADE_DIR, 'last-result.json');
const ACTIVE_FILENAME = 'active.json';
const RESERVED_NAMES = new Set(['active', 'active-meta']);
const FEEDBACK_STATUSES = new Set(['read', 'connected', 'unchanged', 'error', 'failed']);
const SUPPORT_EMAIL = 'support@forbrokers.com';
const DEVELOPER_URL = 'https://forbrokers.com';
const UUID_V4_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const UPGRADE_FILES = new Set([
  'admin.html',
  'VERSION',
  'install.sh',
  'reset-password.sh',
  'apply-upgrade.sh',
  'README.md',
  'backend/server.js',
  'backend/reset-password.js',
  'backend/package.json',
  'backend/package-lock.json',
  'docs/API_EN.md',
  'docs/API_ZH.md'
]);
const uuidv4 = () => crypto.randomUUID();

fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o750 });
fs.mkdirSync(UPGRADE_DIR, { recursive: true, mode: 0o750 });

function writeJsonAtomic(file, value, mode = 0o640) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
  fs.renameSync(tmp, file);
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { users: [], feedback: [] };
  const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  return {
    users: Array.isArray(parsed.users) ? parsed.users : [],
    feedback: Array.isArray(parsed.feedback) ? parsed.feedback : []
  };
}

function saveState(state) {
  writeJsonAtomic(STATE_FILE, {
    users: state.users,
    feedback: state.feedback.slice(-2000)
  });
}

const state = loadState();

function bootstrapPassword() {
  if (process.env.ADMIN_PASSWORD_B64) {
    return Buffer.from(process.env.ADMIN_PASSWORD_B64, 'base64').toString('utf8');
  }
  return process.env.ADMIN_PASSWORD || '';
}

function ensureBootstrapAdmin() {
  if (state.users.length) return;
  const username = String(process.env.ADMIN_USERNAME || 'admin').trim();
  const password = bootstrapPassword();
  if (!username || password.length < 12) {
    throw new Error('First start requires ADMIN_PASSWORD or ADMIN_PASSWORD_B64 with at least 12 characters');
  }
  state.users.push({
    id: uuidv4(),
    username,
    password_hash: bcrypt.hashSync(password, 12),
    created_at: new Date().toISOString()
  });
  saveState(state);
}

ensureBootstrapAdmin();

function loadOrCreateJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (fs.existsSync(JWT_SECRET_FILE)) return fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(JWT_SECRET_FILE, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
  return secret;
}

const JWT_SECRET = loadOrCreateJwtSecret();

function sanitizeText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/[<>\r\n]/g, '').trim().slice(0, maxLength);
}

function isUuid(value) {
  return UUID_V4_PATTERN.test(String(value || ''));
}

function currentVersion() {
  try {
    const version = fs.readFileSync(path.join(APP_ROOT, 'VERSION'), 'utf8').trim();
    return VERSION_PATTERN.test(version) ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function zipEntries(zipFile) {
  const result = spawnSync('unzip', ['-Z1', zipFile], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024,
    timeout: 10000
  });
  if (result.error?.code === 'ENOENT') throw new Error('The unzip command is not installed on the server');
  if (result.status !== 0) throw new Error('Invalid ZIP update package');
  return result.stdout.split('\n').filter(Boolean);
}

function rejectZipSymlinks(zipFile) {
  const result = spawnSync('zipinfo', ['-l', zipFile], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024,
    timeout: 10000
  });
  if (result.error?.code === 'ENOENT') throw new Error('The zipinfo command is not installed on the server');
  if (result.status !== 0) throw new Error('Invalid ZIP update package');
  if (result.stdout.split('\n').some(line => /^l[rwx-]{9}\s/.test(line))) throw new Error('Symbolic links are not allowed in update packages');
}

function zipEntryData(zipFile, entry) {
  const result = spawnSync('unzip', ['-p', zipFile, entry], {
    encoding: null,
    maxBuffer: 2 * 1024 * 1024,
    timeout: 10000
  });
  if (result.status !== 0) throw new Error(`Unable to read ${entry}`);
  return result.stdout;
}

function validateUpgradePackage(zipFile) {
  rejectZipSymlinks(zipFile);
  const entries = zipEntries(zipFile);
  if (!entries.length || entries.length > 40) throw new Error('Invalid update package contents');
  const prefix = entries[0].split('/')[0];
  const prefixMatch = prefix.match(/^forbrokers-plugin-console-v(\d+\.\d+\.\d+)$/);
  if (!prefixMatch) throw new Error('Invalid update package directory');

  const packageVersion = prefixMatch[1];
  const seen = new Set();
  for (const entry of entries) {
    if (entry.includes('\\') || entry.startsWith('/') || entry.includes('\0')) throw new Error('Unsafe ZIP path');
    const parts = entry.split('/');
    if (parts.some(part => part === '..')) throw new Error('Unsafe ZIP path');
    if (entry === `${prefix}/` || entry === `${prefix}/backend/` || entry === `${prefix}/docs/`) continue;
    if (!entry.startsWith(`${prefix}/`) || entry.endsWith('/')) throw new Error(`Unsupported ZIP entry: ${entry}`);
    const relative = entry.slice(prefix.length + 1);
    if (!UPGRADE_FILES.has(relative)) throw new Error(`Unsupported update file: ${relative}`);
    if (seen.has(relative)) throw new Error(`Duplicate update file: ${relative}`);
    seen.add(relative);
  }

  for (const required of UPGRADE_FILES) {
    if (!seen.has(required)) throw new Error(`Update package is missing ${required}`);
  }

  let totalBytes = 0;
  for (const relative of UPGRADE_FILES) {
    totalBytes += zipEntryData(zipFile, `${prefix}/${relative}`).length;
    if (totalBytes > 8 * 1024 * 1024) throw new Error('Update package contents are too large');
  }

  const versionFile = zipEntryData(zipFile, `${prefix}/VERSION`).toString('utf8').trim();
  if (versionFile !== packageVersion) throw new Error('Update package versions do not match');
  const packageJson = JSON.parse(zipEntryData(zipFile, `${prefix}/backend/package.json`).toString('utf8'));
  const packageLock = JSON.parse(zipEntryData(zipFile, `${prefix}/backend/package-lock.json`).toString('utf8'));
  if (packageJson.version !== packageVersion || packageLock.version !== packageVersion || packageLock.packages?.['']?.version !== packageVersion) {
    throw new Error('Update package versions do not match');
  }

  const installedVersion = currentVersion();
  if (installedVersion !== 'unknown' && compareVersions(packageVersion, installedVersion) <= 0) {
    throw new Error(`Update version must be newer than ${installedVersion}`);
  }
  return packageVersion;
}

function normalizeFilename(value, allowReserved = false) {
  let name = String(value || '').trim().replace(/\.json$/i, '');
  name = path.basename(name).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80);
  name = name.replace(/_+/g, '_').replace(/[._-]+$/g, '');
  if (!name) throw new Error('Configuration name is required');
  if (!allowReserved && RESERVED_NAMES.has(name.toLowerCase())) throw new Error(`${name}.json is reserved`);
  return `${name}.json`;
}

function configPath(filename, allowReserved = false) {
  return path.join(CONFIG_DIR, normalizeFilename(filename, allowReserved));
}

function normalizeData(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Configuration data must be valid JSON');
  if (Buffer.byteLength(encoded, 'utf8') > 256 * 1024) throw new Error('Configuration data is too large');
  return JSON.parse(encoded);
}

function readConfig(filename, allowReserved = false) {
  const safe = normalizeFilename(filename, allowReserved);
  const file = path.join(CONFIG_DIR, safe);
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || !isUuid(value.uuid) || typeof value.updated_at !== 'string') {
    throw new Error(`Invalid configuration file: ${safe}`);
  }
  return value;
}

function writeConfig(filename, value, allowReserved = false) {
  const safe = normalizeFilename(filename, allowReserved);
  writeJsonAtomic(path.join(CONFIG_DIR, safe), value);
  return safe;
}

function configFilenames() {
  return fs.readdirSync(CONFIG_DIR)
    .filter(name => name.endsWith('.json') && name !== ACTIVE_FILENAME && name !== 'active-meta.json')
    .sort((a, b) => a.localeCompare(b));
}

function activeFilename() {
  for (const filename of configFilenames()) {
    const config = readConfig(filename);
    if (config.enabled) return filename;
  }
  return null;
}

function removeActiveAlias() {
  const file = configPath(ACTIVE_FILENAME, true);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

function syncActiveAlias(filename) {
  const config = readConfig(filename);
  if (!config || !config.enabled) {
    removeActiveAlias();
    return;
  }
  writeConfig(ACTIVE_FILENAME, config, true);
}

function publicHeaders(res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
}

function baseUrl(req) {
  const configured = String(process.env.PRIMARY_DOMAIN || '').trim().replace(/\/$/, '');
  return configured || `${req.protocol}://${req.get('host')}`;
}

function configSummary(filename, req) {
  const config = readConfig(filename);
  return {
    filename,
    uuid: config.uuid,
    updated_at: config.updated_at,
    enabled: Boolean(config.enabled),
    public_url: `${baseUrl(req)}/admin-api/plugin-public/${encodeURIComponent(filename)}`
  };
}

function authMiddleware(req, res, next) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '512kb' }));

const loginLimiter = rateLimit({ windowMs: 5 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const adminLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
const feedbackLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
const upgradeLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });

app.post('/admin-api/login', loginLimiter, (req, res) => {
  const username = sanitizeText(req.body?.username, 80);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = state.users.find(row => row.username === username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, username: user.username });
});

app.get('/admin-api/me', authMiddleware, (req, res) => {
  res.json({ username: req.user.username });
});

app.put('/admin-api/password', authMiddleware, adminLimiter, (req, res) => {
  const currentPassword = typeof req.body?.current_password === 'string' ? req.body.current_password : '';
  const newPassword = typeof req.body?.new_password === 'string' ? req.body.new_password : '';
  const user = state.users.find(row => row.id === req.user.id);
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  if (newPassword.length < 12) return res.status(400).json({ error: 'New password must contain at least 12 characters' });
  user.password_hash = bcrypt.hashSync(newPassword, 12);
  saveState(state);
  res.json({ ok: true });
});

app.get('/admin-api/configs', authMiddleware, adminLimiter, (req, res) => {
  try {
    const configs = configFilenames().map(filename => configSummary(filename, req));
    const active = configs.find(row => row.enabled) || null;
    res.json({
      configs,
      active_meta: active ? { uuid: active.uuid, updated_at: active.updated_at } : null,
      active_url: `${baseUrl(req)}/admin-api/plugin-public/active.json`,
      active_meta_url: `${baseUrl(req)}/admin-api/plugin-public/active-meta.json`,
      feedback_url: `${baseUrl(req)}/admin-api/plugin-feedback`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/admin-api/configs/:filename', authMiddleware, adminLimiter, (req, res) => {
  try {
    const filename = normalizeFilename(req.params.filename);
    const content = readConfig(filename);
    if (!content) return res.status(404).json({ error: 'Configuration not found' });
    res.json({ filename, content });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/admin-api/configs', authMiddleware, adminLimiter, (req, res) => {
  try {
    const filename = normalizeFilename(req.body?.filename);
    const existing = readConfig(filename);
    const currentActive = activeFilename();
    const content = {
      uuid: uuidv4(),
      updated_at: new Date().toISOString(),
      enabled: Boolean(existing?.enabled || !currentActive),
      data: normalizeData(req.body?.data)
    };
    writeConfig(filename, content);
    if (content.enabled) syncActiveAlias(filename);
    res.json({ ok: true, filename, content });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/admin-api/configs/:filename/enable', authMiddleware, adminLimiter, (req, res) => {
  try {
    const filename = normalizeFilename(req.params.filename);
    const target = readConfig(filename);
    if (!target) return res.status(404).json({ error: 'Configuration not found' });
    const currentActive = activeFilename();
    const switching = currentActive !== filename;

    for (const item of configFilenames()) {
      const config = readConfig(item);
      if (item === filename) {
        const enabled = {
          ...config,
          uuid: switching ? uuidv4() : config.uuid,
          updated_at: switching ? new Date().toISOString() : config.updated_at,
          enabled: true
        };
        writeConfig(item, enabled);
      } else if (config.enabled) {
        writeConfig(item, { ...config, enabled: false });
      }
    }

    syncActiveAlias(filename);
    const content = readConfig(filename);
    res.json({ ok: true, filename, content });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/admin-api/configs/:filename', authMiddleware, adminLimiter, (req, res) => {
  try {
    const filename = normalizeFilename(req.params.filename);
    const file = configPath(filename);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Configuration not found' });
    const wasActive = Boolean(readConfig(filename)?.enabled);
    fs.unlinkSync(file);
    if (wasActive) removeActiveAlias();
    res.json({ ok: true, filename });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/admin-api/plugin-public/active-meta.json', (req, res) => {
  try {
    publicHeaders(res);
    const active = readConfig(ACTIVE_FILENAME, true);
    if (!active) return res.status(404).json({ error: 'Active configuration not found' });
    res.json({ uuid: active.uuid, updated_at: active.updated_at });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/admin-api/plugin-public/active.json', (req, res) => {
  try {
    publicHeaders(res);
    const active = readConfig(ACTIVE_FILENAME, true);
    if (!active) return res.status(404).json({ error: 'Active configuration not found' });
    res.json(active);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/admin-api/plugin-public/:filename', (req, res) => {
  try {
    publicHeaders(res);
    const filename = normalizeFilename(req.params.filename);
    const config = readConfig(filename);
    if (!config) return res.status(404).json({ error: 'Configuration not found' });
    res.json(config);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

function isFeedbackSubmission(req) {
  return ['uuid', 'status', 'plugin_version'].some(key => Object.prototype.hasOwnProperty.call(req.query || {}, key));
}

app.get('/admin-api/plugin-feedback', feedbackLimiter, (req, res, next) => {
  if (!isFeedbackSubmission(req)) return next();
  publicHeaders(res);

  const allowedKeys = new Set(['uuid', 'status', 'plugin_version']);
  const unsupported = Object.keys(req.query || {}).filter(key => !allowedKeys.has(key));
  if (unsupported.length) return res.status(400).json({ error: `Unsupported parameter: ${unsupported[0]}` });

  const configUuid = sanitizeText(req.query.uuid, 80).toLowerCase();
  const status = sanitizeText(req.query.status, 24).toLowerCase();
  const pluginVersion = sanitizeText(req.query.plugin_version, 40);
  if (!isUuid(configUuid)) return res.status(400).json({ error: 'A valid UUID v4 is required' });
  if (!FEEDBACK_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid status' });
  if (pluginVersion && !/^[A-Za-z0-9._+-]+$/.test(pluginVersion)) {
    return res.status(400).json({ error: 'Invalid plugin_version' });
  }

  const row = {
    id: uuidv4(),
    uuid: configUuid,
    status,
    plugin_version: pluginVersion,
    received_at: new Date().toISOString()
  };
  state.feedback.push(row);
  saveState(state);
  res.json({ ok: true, id: row.id, received_at: row.received_at });
});

app.get('/admin-api/plugin-feedback', authMiddleware, adminLimiter, (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
  res.json({ feedback: state.feedback.slice(-limit).reverse() });
});

app.get('/admin-api/version', authMiddleware, adminLimiter, (req, res) => {
  res.json({ version: currentVersion(), support_email: SUPPORT_EMAIL, developer_url: DEVELOPER_URL });
});

app.get('/admin-api/upgrade/status', authMiddleware, adminLimiter, (req, res) => {
  try {
    if (fs.existsSync(UPGRADE_READY_FILE)) {
      const pending = JSON.parse(fs.readFileSync(UPGRADE_READY_FILE, 'utf8'));
      return res.json({ state: 'queued', current_version: currentVersion(), ...pending });
    }
    if (fs.existsSync(UPGRADE_RESULT_FILE)) {
      const result = JSON.parse(fs.readFileSync(UPGRADE_RESULT_FILE, 'utf8'));
      return res.json({ current_version: currentVersion(), ...result });
    }
    res.json({ state: 'idle', current_version: currentVersion() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post(
  '/admin-api/upgrade',
  authMiddleware,
  upgradeLimiter,
  express.raw({ type: ['application/zip', 'application/octet-stream'], limit: '25mb' }),
  (req, res) => {
    const temporaryFile = path.join(UPGRADE_DIR, `upload-${process.pid}-${Date.now()}.zip`);
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Select a ZIP update package' });
      if (fs.existsSync(UPGRADE_READY_FILE)) return res.status(409).json({ error: 'An update is already queued' });
      fs.writeFileSync(temporaryFile, req.body, { mode: 0o640 });
      const targetVersion = validateUpgradePackage(temporaryFile);
      fs.renameSync(temporaryFile, UPGRADE_ZIP_FILE);
      if (fs.existsSync(UPGRADE_RESULT_FILE)) fs.unlinkSync(UPGRADE_RESULT_FILE);
      const queuedAt = new Date().toISOString();
      writeJsonAtomic(UPGRADE_READY_FILE, {
        target_version: targetVersion,
        queued_at: queuedAt,
        requested_by: req.user.username
      });
      res.status(202).json({
        ok: true,
        state: 'queued',
        current_version: currentVersion(),
        target_version: targetVersion,
        queued_at: queuedAt
      });
    } catch (error) {
      if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
      res.status(400).json({ error: error.message });
    }
  }
);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get(['/', '/admin'], (req, res) => {
  res.sendFile(path.join(APP_ROOT, 'admin.html'));
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use((error, req, res, next) => {
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Update package is too large' });
  next(error);
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`ForBrokers Plugin Config Console listening on 127.0.0.1:${PORT}`);
  console.log(`Persistent data directory: ${DATA_DIR}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { app, server };
