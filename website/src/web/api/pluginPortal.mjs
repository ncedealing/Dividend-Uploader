import { createHash, createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

export const PLUGIN_NAME = "Dividend Uploader";
export const PLUGIN_SLUG = "dividend-uploader";
export const DOMAIN = process.env.DIVIDEND_UPLOADER_PUBLIC_BASE_URL ?? "https://test.appcdn002.com";
export const ADMIN_PREFIX = "/admin-api";
export const FEEDBACK_STATUSES = new Set(["read", "connected", "unchanged", "error", "failed"]);
const TOKEN_TTL_SECONDS = 12 * 60 * 60;
const MAX_JSON_BODY_BYTES = 512 * 1024;
const MAX_FEEDBACK_RECORDS = 500;
const WEBSITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function utcNow() {
  return new Date().toISOString();
}

function base64UrlEncode(input) {
  return Buffer.from(input).toString("base64url");
}

function base64UrlJson(data) {
  return base64UrlEncode(JSON.stringify(data));
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function jsonResponse(response, status, data, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(data, null, 2));
}

function noCacheHeaders() {
  return {
    "cache-control": "no-store, no-cache, must-revalidate",
    pragma: "no-cache",
    expires: "0",
    "access-control-allow-origin": "*",
  };
}

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function atomicWriteJson(path, data) {
  await ensureDir(resolve(path, ".."));
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, path);
}

async function atomicWriteText(path, text, mode = 0o600) {
  await ensureDir(resolve(path, ".."));
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, text, { mode });
  await rename(tempPath, path);
  await chmod(path, mode).catch(() => {});
}

async function readJsonFile(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function safeFilename(input) {
  const raw = String(input ?? "").trim();
  if (!raw) {
    throw new Error("Filename is required");
  }
  const withoutExt = raw.replace(/\.json$/iu, "");
  const cleaned = withoutExt.replace(/[^a-zA-Z0-9._-]/gu, "-").replace(/-+/gu, "-").slice(0, 80);
  if (!cleaned || cleaned === "active" || cleaned === "active-meta") {
    throw new Error("Reserved or invalid filename");
  }
  return `${cleaned}.json`;
}

function safeStoredPath(root, filename) {
  const target = resolve(root, safeFilename(filename));
  if (!target.startsWith(resolve(root))) {
    throw new Error("Invalid path");
  }
  return target;
}

function normalizeBaseUrl(value) {
  const raw = String(value ?? DOMAIN).trim() || DOMAIN;
  try {
    const parsed = new URL(raw);
    parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return DOMAIN;
  }
}

function normalizeUrlPath(value, fallback) {
  const raw = String(value ?? fallback).trim() || fallback;
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withSlash.replace(/\/+$/u, "");
}

async function readBody(request, maxBytes = MAX_JSON_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error("Request body too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(request) {
  const raw = await readBody(request);
  return raw.length ? JSON.parse(raw.toString("utf8")) : {};
}

function portalPaths(dataDir) {
  const root = resolve(dataDir ?? process.env.DIVIDEND_UPLOADER_PORTAL_DATA_DIR ?? join(WEBSITE_ROOT, "runtime", "portal-data"));
  return {
    root,
    configs: join(root, `${PLUGIN_SLUG}-configs`),
    secrets: join(root, "secrets"),
    feedback: join(root, "feedback.json"),
    admin: join(root, "admin.json"),
    upgrades: join(root, "upgrade-uploads"),
  };
}

async function getSecret(paths) {
  await ensureDir(paths.secrets);
  const path = join(paths.secrets, "session-secret.txt");
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    const secret = process.env.DIVIDEND_UPLOADER_JWT_SECRET ?? randomBytes(48).toString("base64url");
    await atomicWriteText(path, `${secret}\n`, 0o600);
    return secret;
  }
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const hash = await scrypt(String(password), salt, 32);
  return `scrypt:${salt}:${Buffer.from(hash).toString("base64url")}`;
}

async function verifyPassword(password, stored) {
  const [algo, salt, encoded] = String(stored ?? "").split(":");
  if (algo !== "scrypt" || !salt || !encoded) {
    return false;
  }
  const expected = Buffer.from(encoded, "base64url");
  const actual = await scrypt(String(password), salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function loadOrBootstrapAdmin(paths, username, password) {
  const existing = await readJsonFile(paths.admin, null);
  if (existing) {
    return existing;
  }
  const envUser = process.env.DIVIDEND_UPLOADER_ADMIN_USER;
  const envPassword = process.env.DIVIDEND_UPLOADER_ADMIN_PASSWORD;
  if (!envUser || !envPassword || username !== envUser || password !== envPassword) {
    return null;
  }
  const admin = {
    username: envUser,
    passwordHash: await hashPassword(envPassword),
    mustChangePassword: true,
    createdAt: utcNow(),
    updatedAt: utcNow(),
  };
  await atomicWriteJson(paths.admin, admin);
  return admin;
}

function signToken(payload, secret) {
  const header = base64UrlJson({ alg: "HS256", typ: "JWT" });
  const body = base64UrlJson(payload);
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

async function createToken(username, paths) {
  const secret = await getSecret(paths);
  const now = Math.floor(Date.now() / 1000);
  return signToken({ sub: username, iat: now, exp: now + TOKEN_TTL_SECONDS }, secret);
}

async function verifyToken(token, paths) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) {
    return null;
  }
  const secret = await getSecret(paths);
  const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest("base64url");
  if (!safeEqual(expected, parts[2])) {
    return null;
  }
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}

async function requireAuth(request, paths) {
  const auth = request.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const payload = await verifyToken(token, paths);
  if (!payload) {
    return null;
  }
  const admin = await readJsonFile(paths.admin, null);
  return admin?.username === payload.sub ? admin : null;
}

function basePortalConfigData() {
  return {
    pluginName: PLUGIN_NAME,
    domain: DOMAIN,
    publicBasePath: `${ADMIN_PREFIX}/${PLUGIN_SLUG}-public`,
    feedbackPath: `${ADMIN_PREFIX}/${PLUGIN_SLUG}-feedback`,
    targetContext: {
      platform: "both",
      serverId: "select-on-page",
      effectiveFromLocal: "",
      effectiveFromTimezone: "Asia/Shanghai",
      effectiveFromUtc: null,
      effectiveFrom: null,
    },
    remoteSync: {
      baseUrl: DOMAIN,
      publicBasePath: `${ADMIN_PREFIX}/${PLUGIN_SLUG}-public`,
      feedbackPath: `${ADMIN_PREFIX}/${PLUGIN_SLUG}-feedback`,
      metadataIntervalSeconds: 300,
      heartbeatIntervalSeconds: 300,
      fullConfigFile: "active.json",
      metadataFile: "active-meta.json",
    },
    timeSync: {
      businessTimezone: "Asia/Shanghai",
      serverTimezone: "auto-mt-server",
      serverTimezoneMode: "auto",
      pluginTimezoneSource: "mt-server",
      effectiveTimeMode: "business-timezone",
      publishTimestamps: "utc",
      requirePluginUtcClock: true,
      maxClockDriftSeconds: 120,
    },
    overnightInterest: {
      csvRequiredColumns: ["mtSymbolMask", "longInterestValue", "shortInterestValue"],
      csvOptionalColumns: ["groupMask", "currency", "remark"],
      pageContextRequired: ["platform", "serverId", "effectiveFrom"],
      readOnlyContextFields: ["interestMode", "tripleDay"],
      updateFields: ["longInterestValue", "shortInterestValue"],
    },
    dividend: {
      enabled: true,
      executionMode: "server-plugin-json-sync",
    },
  };
}

function normalizePortalConfigData(input = {}) {
  const base = basePortalConfigData();
  const data = structuredClone(input && typeof input === "object" ? input : {});
  const remoteInput = { ...base.remoteSync, ...(data.remoteSync ?? {}) };
  const baseUrl = normalizeBaseUrl(remoteInput.baseUrl ?? data.domain);
  const publicBasePath = normalizeUrlPath(remoteInput.publicBasePath ?? data.publicBasePath, base.remoteSync.publicBasePath);
  const feedbackPath = normalizeUrlPath(remoteInput.feedbackPath ?? data.feedbackPath, base.remoteSync.feedbackPath);
  const timeSync = {
    ...base.timeSync,
    ...(data.timeSync ?? {}),
  };
  timeSync.businessTimezone = String(timeSync.businessTimezone || "Asia/Shanghai").trim();
  timeSync.serverTimezone = String(timeSync.serverTimezone || "auto-mt-server").trim();
  timeSync.serverTimezoneMode =
    timeSync.serverTimezoneMode ?? (timeSync.serverTimezone === "auto-mt-server" ? "auto" : "manual");
  timeSync.pluginTimezoneSource =
    timeSync.pluginTimezoneSource ?? (timeSync.serverTimezone === "auto-mt-server" ? "mt-server" : "manual");

  return {
    ...base,
    ...data,
    domain: baseUrl,
    publicBasePath,
    feedbackPath,
    remoteSync: {
      ...remoteInput,
      baseUrl,
      publicBasePath,
      feedbackPath,
      metadataFile: String(remoteInput.metadataFile || "active-meta.json").trim(),
      fullConfigFile: String(remoteInput.fullConfigFile || "active.json").trim(),
    },
    timeSync,
    targetContext: {
      ...base.targetContext,
      ...(data.targetContext ?? {}),
      effectiveFromTimezone: data.targetContext?.effectiveFromTimezone ?? timeSync.businessTimezone,
    },
    overnightInterest: {
      ...base.overnightInterest,
      ...(data.overnightInterest ?? {}),
    },
  };
}

function defaultPortalConfigData() {
  return normalizePortalConfigData(basePortalConfigData());
}

function normalizeConfigBody(body, existing = null) {
  const enabled = Boolean(body.enabled ?? existing?.enabled ?? true);
  return {
    uuid: randomUUID(),
    updated_at: utcNow(),
    enabled,
    data: normalizePortalConfigData(body.data ?? body.config ?? defaultPortalConfigData()),
  };
}

async function readConfig(paths, filename) {
  return readJsonFile(safeStoredPath(paths.configs, filename));
}

async function listConfigFiles(paths) {
  await ensureDir(paths.configs);
  const entries = await (await import("node:fs/promises")).readdir(paths.configs, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "active.json" || entry.name === "active-meta.json") {
      continue;
    }
    const content = await readJsonFile(join(paths.configs, entry.name), null);
    if (!content) {
      continue;
    }
    files.push({
      filename: entry.name,
      uuid: content.uuid,
      updated_at: content.updated_at,
      enabled: Boolean(content.enabled),
      dataSummary: summarizeConfigData(content.data),
    });
  }
  return files.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
}

function summarizeConfigData(data) {
  return {
    pluginName: data?.pluginName ?? PLUGIN_NAME,
    baseUrl: data?.remoteSync?.baseUrl ?? data?.domain ?? DOMAIN,
    businessTimezone: data?.timeSync?.businessTimezone ?? "Asia/Shanghai",
    updateFields: data?.overnightInterest?.updateFields ?? ["longInterestValue", "shortInterestValue"],
  };
}

async function activeConfig(paths) {
  return readJsonFile(join(paths.configs, "active.json"), null);
}

async function syncActive(paths, filename, content) {
  await ensureDir(paths.configs);
  await atomicWriteJson(join(paths.configs, "active.json"), content);
  await atomicWriteJson(join(paths.configs, "active-meta.json"), {
    uuid: content.uuid,
    updated_at: content.updated_at,
  });
  const files = await listConfigFiles(paths);
  for (const file of files) {
    if (file.filename === filename) {
      continue;
    }
    const path = safeStoredPath(paths.configs, file.filename);
    const other = await readJsonFile(path);
    if (other?.enabled) {
      await atomicWriteJson(path, { ...other, enabled: false });
    }
  }
}

async function removeActive(paths) {
  await unlink(join(paths.configs, "active.json")).catch(() => {});
  await unlink(join(paths.configs, "active-meta.json")).catch(() => {});
}

async function saveConfig(paths, body) {
  await ensureDir(paths.configs);
  const filename = safeFilename(body.filename ?? body.name ?? "dividend-uploader-config");
  const existing = await readJsonFile(safeStoredPath(paths.configs, filename), null);
  const content = normalizeConfigBody(body, existing);
  const currentActive = await activeConfig(paths);
  if (!currentActive) {
    content.enabled = true;
  }
  await atomicWriteJson(safeStoredPath(paths.configs, filename), content);
  if (content.enabled) {
    await syncActive(paths, filename, content);
  }
  return { filename, content };
}

async function enableConfig(paths, filename) {
  const name = safeFilename(filename);
  const content = await readConfig(paths, name);
  if (!content) {
    return null;
  }
  const enabledContent = { ...content, enabled: true };
  await atomicWriteJson(safeStoredPath(paths.configs, name), enabledContent);
  await syncActive(paths, name, enabledContent);
  return enabledContent;
}

async function deleteConfig(paths, filename) {
  const name = safeFilename(filename);
  const content = await readConfig(paths, name);
  if (!content) {
    return false;
  }
  await unlink(safeStoredPath(paths.configs, name));
  const active = await activeConfig(paths);
  if (active?.uuid === content.uuid) {
    await removeActive(paths);
  }
  return true;
}

async function readFeedback(paths) {
  return readJsonFile(paths.feedback, []);
}

function sanitizeFeedback(value, limit = 160) {
  return String(value ?? "")
    .replace(/[\r\n\t]/gu, " ")
    .replace(/[<>]/gu, "")
    .slice(0, limit);
}

async function recordFeedback(paths, query, request) {
  const status = sanitizeFeedback(query.get("status"), 32);
  if (!FEEDBACK_STATUSES.has(status)) {
    throw new Error("Invalid feedback status");
  }
  const uuid = sanitizeFeedback(query.get("uuid"), 80);
  if (!uuid) {
    throw new Error("Feedback uuid is required");
  }
  const active = await activeConfig(paths);
  const record = {
    id: randomUUID(),
    received_at: utcNow(),
    uuid,
    filename: sanitizeFeedback(query.get("filename") ?? "active.json", 80),
    status,
    mode: sanitizeFeedback(query.get("mode"), 40),
    message: sanitizeFeedback(query.get("message"), 240),
    server: sanitizeFeedback(query.get("server"), 80),
    account: sanitizeFeedback(query.get("account"), 80),
    plugin_version: sanitizeFeedback(query.get("plugin_version"), 40),
    source_ip: sanitizeFeedback(request.headers["x-forwarded-for"] ?? request.socket?.remoteAddress ?? "", 80),
    is_current_uuid: Boolean(active?.uuid && active.uuid === uuid),
  };
  const records = [record, ...(await readFeedback(paths))].slice(0, MAX_FEEDBACK_RECORDS);
  await atomicWriteJson(paths.feedback, records);
  return record;
}

function feedbackStatus(active, records) {
  if (!active) {
    return { state: "neutral", label: "No active configuration", detail: "Save and enable a configuration first." };
  }
  const current = records.find((record) => record.uuid === active.uuid);
  if (!current) {
    return { state: "neutral", label: "Waiting for plugin load", detail: `Current UUID ${active.uuid} has no successful feedback yet.` };
  }
  if (current.status === "error" || current.status === "failed") {
    return { state: "error", label: "Plugin reported an error", detail: current.message || current.status };
  }
  const ageMs = Date.now() - Date.parse(current.received_at);
  if (ageMs > 10 * 60 * 1000) {
    return { state: "error", label: "Connection stale", detail: `Last current feedback at ${current.received_at}` };
  }
  return { state: "ok", label: "Plugin connected", detail: `Last ${current.status} at ${current.received_at}` };
}

async function versionPayload(paths) {
  let version = "0.2.4";
  try {
    version = (await readFile(join(process.cwd(), "VERSION"), "utf8")).trim();
  } catch {
    // Keep fallback.
  }
  const packageJson = await readJsonFile(join(process.cwd(), "package.json"), {});
  return {
    service: PLUGIN_NAME,
    slug: PLUGIN_SLUG,
    version,
    packageVersion: packageJson.version ?? version,
    dataDir: paths.root,
  };
}

async function storeUpgrade(paths, request) {
  const body = await readBody(request, 30 * 1024 * 1024);
  if (body.length < 4 || body[0] !== 0x50 || body[1] !== 0x4b) {
    throw new Error("Only ZIP upgrade packages are accepted");
  }
  await ensureDir(paths.upgrades);
  const nameHeader = basename(String(request.headers["x-upgrade-filename"] ?? `uploaded-upgrade-${Date.now()}.zip`)).replace(/[^a-zA-Z0-9._-]/gu, "-");
  if (!nameHeader.endsWith(".zip")) {
    throw new Error("Upgrade filename must end with .zip");
  }
  const destination = join(paths.upgrades, nameHeader);
  await writeFile(destination, body, { mode: 0o600 });
  const active = await activeConfig(paths);
  return {
    stored: destination,
    size: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
    activeBefore: active ? { uuid: active.uuid, updated_at: active.updated_at } : null,
    appliedFiles: [],
    restartRequired: true,
    note: "Package stored and validated as ZIP. Apply with the generated install/upgrade script so runtime data remains outside the deploy directory.",
  };
}

function hasFeedbackParams(url) {
  return url.searchParams.has("uuid") || url.searchParams.has("status") || url.searchParams.has("mode");
}

async function protectedRoute({ request, response, url, paths, handler }) {
  const admin = await requireAuth(request, paths);
  if (!admin) {
    jsonResponse(response, 401, { error: "Unauthorized" });
    return;
  }
  await handler(admin);
}

export async function routePluginPortal({ request, response, url, portalDataDir }) {
  const method = request.method ?? "GET";
  const pathname = url.pathname;
  const paths = portalPaths(portalDataDir);
  await ensureDir(paths.root);
  await ensureDir(paths.configs);

  if (method === "OPTIONS" && pathname.startsWith(ADMIN_PREFIX)) {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "authorization,content-type,x-upgrade-filename",
    });
    response.end();
    return true;
  }

  if (method === "POST" && pathname === `${ADMIN_PREFIX}/login`) {
    const body = await readJsonBody(request);
    const admin = await loadOrBootstrapAdmin(paths, body.username, body.password);
    if (!admin || !(await verifyPassword(body.password, admin.passwordHash))) {
      jsonResponse(response, 401, { error: "Invalid username or password" });
      return true;
    }
    jsonResponse(response, 200, {
      ok: true,
      token: await createToken(admin.username, paths),
      username: admin.username,
      mustChangePassword: Boolean(admin.mustChangePassword),
    });
    return true;
  }

  if (method === "POST" && pathname === `${ADMIN_PREFIX}/change-password`) {
    await protectedRoute({ request, response, url, paths, handler: async (admin) => {
      const body = await readJsonBody(request);
      if (!(await verifyPassword(body.currentPassword, admin.passwordHash))) {
        jsonResponse(response, 403, { error: "Current password is invalid" });
        return;
      }
      if (String(body.newPassword ?? "").length < 8) {
        jsonResponse(response, 400, { error: "New password must be at least 8 characters" });
        return;
      }
      await atomicWriteJson(paths.admin, {
        ...admin,
        passwordHash: await hashPassword(body.newPassword),
        mustChangePassword: false,
        updatedAt: utcNow(),
      });
      jsonResponse(response, 200, { ok: true });
    } });
    return true;
  }

  if (method === "GET" && pathname === `${ADMIN_PREFIX}/${PLUGIN_SLUG}-public/active-meta.json`) {
    const active = await activeConfig(paths);
    if (!active) {
      jsonResponse(response, 404, { error: "Active config not found" }, noCacheHeaders());
      return true;
    }
    jsonResponse(response, 200, { uuid: active.uuid, updated_at: active.updated_at }, noCacheHeaders());
    return true;
  }

  if (method === "GET" && pathname === `${ADMIN_PREFIX}/${PLUGIN_SLUG}-public/active.json`) {
    const active = await activeConfig(paths);
    if (!active) {
      jsonResponse(response, 404, { error: "Active config not found" }, noCacheHeaders());
      return true;
    }
    jsonResponse(response, 200, active, noCacheHeaders());
    return true;
  }

  const publicFileMatch = pathname.match(new RegExp(`^${ADMIN_PREFIX}/${PLUGIN_SLUG}-public/([^/]+)$`, "u"));
  if (method === "GET" && publicFileMatch) {
    const content = await readConfig(paths, decodeURIComponent(publicFileMatch[1]));
    if (!content) {
      jsonResponse(response, 404, { error: "Config not found" }, noCacheHeaders());
      return true;
    }
    jsonResponse(response, 200, content, noCacheHeaders());
    return true;
  }

  if (method === "GET" && pathname === `${ADMIN_PREFIX}/${PLUGIN_SLUG}-feedback` && hasFeedbackParams(url)) {
    try {
      const record = await recordFeedback(paths, url.searchParams, request);
      jsonResponse(response, 200, { ok: true, id: record.id, received_at: record.received_at }, noCacheHeaders());
    } catch (error) {
      jsonResponse(response, 400, { error: error.message }, noCacheHeaders());
    }
    return true;
  }

  if (method === "POST" && pathname === `${ADMIN_PREFIX}/${PLUGIN_SLUG}-feedback`) {
    try {
      const body = await readJsonBody(request);
      const params = new URLSearchParams(body);
      const record = await recordFeedback(paths, params, request);
      jsonResponse(response, 200, { ok: true, id: record.id, received_at: record.received_at }, noCacheHeaders());
    } catch (error) {
      jsonResponse(response, 400, { error: error.message }, noCacheHeaders());
    }
    return true;
  }

  if (method === "GET" && pathname === `${ADMIN_PREFIX}/${PLUGIN_SLUG}-configs`) {
    await protectedRoute({ request, response, url, paths, handler: async () => {
      const active = await activeConfig(paths);
      const feedback = await readFeedback(paths);
      jsonResponse(response, 200, {
        files: await listConfigFiles(paths),
        active,
        status: feedbackStatus(active, feedback),
        integration: integrationUrls(active),
        defaultData: defaultPortalConfigData(),
      });
    } });
    return true;
  }

  const configFileMatch = pathname.match(new RegExp(`^${ADMIN_PREFIX}/${PLUGIN_SLUG}-configs/([^/]+)$`, "u"));
  if (method === "GET" && configFileMatch) {
    await protectedRoute({ request, response, url, paths, handler: async () => {
      const filename = decodeURIComponent(configFileMatch[1]);
      const content = await readConfig(paths, filename);
      if (!content) {
        jsonResponse(response, 404, { error: "Config not found" });
        return;
      }
      jsonResponse(response, 200, { filename: safeFilename(filename), content });
    } });
    return true;
  }

  if (method === "POST" && pathname === `${ADMIN_PREFIX}/${PLUGIN_SLUG}-configs`) {
    await protectedRoute({ request, response, url, paths, handler: async () => {
      const result = await saveConfig(paths, await readJsonBody(request));
      jsonResponse(response, 201, { ok: true, ...result });
    } });
    return true;
  }

  const enableMatch = pathname.match(new RegExp(`^${ADMIN_PREFIX}/${PLUGIN_SLUG}-configs/([^/]+)/enable$`, "u"));
  if (method === "PUT" && enableMatch) {
    await protectedRoute({ request, response, url, paths, handler: async () => {
      const content = await enableConfig(paths, decodeURIComponent(enableMatch[1]));
      if (!content) {
        jsonResponse(response, 404, { error: "Config not found" });
        return;
      }
      jsonResponse(response, 200, { ok: true, content });
    } });
    return true;
  }

  if (method === "DELETE" && configFileMatch) {
    await protectedRoute({ request, response, url, paths, handler: async () => {
      const ok = await deleteConfig(paths, decodeURIComponent(configFileMatch[1]));
      jsonResponse(response, ok ? 200 : 404, ok ? { ok: true } : { error: "Config not found" });
    } });
    return true;
  }

  if (method === "GET" && pathname === `${ADMIN_PREFIX}/${PLUGIN_SLUG}-feedback`) {
    await protectedRoute({ request, response, url, paths, handler: async () => {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 20)));
      const feedback = await readFeedback(paths);
      const active = await activeConfig(paths);
      jsonResponse(response, 200, {
        records: feedback.slice(0, limit),
        status: feedbackStatus(active, feedback),
        activeUuid: active?.uuid ?? null,
      });
    } });
    return true;
  }

  if (method === "GET" && pathname === `${ADMIN_PREFIX}/version`) {
    await protectedRoute({ request, response, url, paths, handler: async () => {
      jsonResponse(response, 200, await versionPayload(paths));
    } });
    return true;
  }

  if (method === "POST" && pathname === `${ADMIN_PREFIX}/upgrade`) {
    await protectedRoute({ request, response, url, paths, handler: async () => {
      try {
        jsonResponse(response, 200, { ok: true, ...(await storeUpgrade(paths, request)) });
      } catch (error) {
        jsonResponse(response, 400, { error: error.message });
      }
    } });
    return true;
  }

  return false;
}

function integrationUrls(active) {
  const data = normalizePortalConfigData(active?.data ?? defaultPortalConfigData());
  const remoteSync = data.remoteSync;
  return {
    activeMetaUrl: `${remoteSync.baseUrl}${remoteSync.publicBasePath}/${remoteSync.metadataFile}`,
    activeConfigUrl: `${remoteSync.baseUrl}${remoteSync.publicBasePath}/${remoteSync.fullConfigFile}`,
    feedbackUrl: `${remoteSync.baseUrl}${remoteSync.feedbackPath}`,
    currentUuid: active?.uuid ?? null,
    baseUrl: remoteSync.baseUrl,
    businessTimezone: data.timeSync.businessTimezone,
    serverTimezone: data.timeSync.serverTimezone,
  };
}
