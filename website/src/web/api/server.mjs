import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createLedger } from "../../adapters/storage/createLedger.mjs";
import { MockExecutionAdapter } from "../../adapters/mock/MockExecutionAdapter.mjs";
import { composeAuditEmail } from "../../adapters/mail/AuditMailComposer.mjs";
import { buildDryRun } from "../../core/dry-run/dryRunEngine.mjs";
import { loadDefaultDividendConfig } from "../../core/domain/defaultConfig.mjs";
import { applyAdjustmentPlans } from "../../core/execution/applyEngine.mjs";
import { runFinnhubSync } from "../../jobs/sync/finnhubSyncJob.mjs";
import { routePluginPortal } from "./pluginPortal.mjs";

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".mjs", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);

function sendJson(response, status, data) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data, null, 2));
}

function sendError(response, status, message, details = undefined) {
  sendJson(response, status, { error: message, details });
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function getOperator(request, body = {}) {
  return body.operator ?? request.headers["x-operator"] ?? "web-operator";
}

function getConfig(ledger) {
  const latest = ledger.getLatestConfigVersion();
  if (latest) {
    return latest;
  }
  const config = loadDefaultDividendConfig();
  const id = ledger.saveConfigVersion(config, {
    operator: "system",
    reason: "bootstrap default web config",
    label: "bootstrap",
  });
  return { id, config, createdBy: "system", reason: "bootstrap default web config" };
}

function redactConfig(config) {
  const redacted = structuredClone(config);
  if (redacted.finnhub?.apiKey) {
    redacted.finnhub.apiKey = `${redacted.finnhub.apiKey.slice(0, 4)}...masked`;
  }
  return redacted;
}

function updateMapping(config, mappingId, patch) {
  const next = structuredClone(config);
  const index = (next.mappings ?? []).findIndex((mapping) => mapping.id === mappingId);
  if (index === -1) {
    return null;
  }
  next.mappings[index] = { ...next.mappings[index], ...patch, id: mappingId };
  return next;
}

function deleteMapping(config, mappingId) {
  const next = structuredClone(config);
  next.mappings = (next.mappings ?? []).filter((mapping) => mapping.id !== mappingId);
  return next;
}

async function serveStatic(request, response, pathname) {
  const uiRoot = fileURLToPath(new URL("../ui/", import.meta.url));
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const normalized = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const absolute = join(uiRoot, normalized);
  if (!absolute.startsWith(uiRoot)) {
    sendError(response, 403, "Forbidden");
    return;
  }
  try {
    const content = await readFile(absolute);
    response.writeHead(200, { "content-type": MIME.get(extname(absolute)) ?? "text/plain; charset=utf-8" });
    response.end(content);
  } catch {
    sendError(response, 404, "Not found");
  }
}

async function routeApi({ request, response, ledger, url }) {
  const method = request.method ?? "GET";
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, { ok: true, service: "Dividend Uploader", time: new Date().toISOString() });
    return;
  }

  if (method === "GET" && pathname === "/api/config") {
    const latest = getConfig(ledger);
    sendJson(response, 200, {
      id: latest.id,
      config: redactConfig(latest.config),
      createdBy: latest.createdBy,
      reason: latest.reason,
    });
    return;
  }

  if (method === "POST" && pathname === "/api/config") {
    const body = await readJsonBody(request);
    const operator = getOperator(request, body);
    const id = ledger.saveConfigVersion(body.config ?? body, {
      operator,
      reason: body.reason ?? "web config save",
      label: body.label ?? "web",
    });
    sendJson(response, 201, { id });
    return;
  }

  if (method === "GET" && pathname === "/api/mappings") {
    const latest = getConfig(ledger);
    sendJson(response, 200, { mappings: latest.config.mappings ?? [], configVersionId: latest.id });
    return;
  }

  if (method === "POST" && pathname === "/api/mappings") {
    const body = await readJsonBody(request);
    const latest = getConfig(ledger);
    const config = structuredClone(latest.config);
    config.mappings = [...(config.mappings ?? []), { id: body.id ?? `map-${randomUUID()}`, ...body }];
    const id = ledger.saveConfigVersion(config, {
      operator: getOperator(request, body),
      reason: body.reason ?? "mapping added",
      label: "mapping-add",
    });
    sendJson(response, 201, { configVersionId: id, mappings: config.mappings });
    return;
  }

  const mappingMatch = pathname.match(/^\/api\/mappings\/([^/]+)$/u);
  if (mappingMatch && (method === "PUT" || method === "PATCH")) {
    const body = await readJsonBody(request);
    const latest = getConfig(ledger);
    const config = updateMapping(latest.config, decodeURIComponent(mappingMatch[1]), body);
    if (!config) {
      sendError(response, 404, "Mapping not found");
      return;
    }
    const id = ledger.saveConfigVersion(config, {
      operator: getOperator(request, body),
      reason: body.reason ?? "mapping updated",
      label: "mapping-update",
    });
    sendJson(response, 200, { configVersionId: id, mappings: config.mappings });
    return;
  }

  if (mappingMatch && method === "DELETE") {
    const body = await readJsonBody(request);
    const latest = getConfig(ledger);
    const config = deleteMapping(latest.config, decodeURIComponent(mappingMatch[1]));
    const id = ledger.saveConfigVersion(config, {
      operator: getOperator(request, body),
      reason: body.reason ?? "mapping deleted",
      label: "mapping-delete",
    });
    sendJson(response, 200, { configVersionId: id, mappings: config.mappings });
    return;
  }

  if (method === "GET" && pathname === "/api/dividends") {
    sendJson(response, 200, { records: ledger.listDividendRecords() });
    return;
  }

  if (method === "POST" && pathname === "/api/dividends/import") {
    const body = await readJsonBody(request);
    const records = body.records ?? [];
    const count = ledger.upsertDividendRecords(records, {
      operator: getOperator(request, body),
      reason: body.reason ?? "manual dividend import",
    });
    sendJson(response, 201, { count });
    return;
  }

  if (method === "POST" && pathname === "/api/finnhub/sync") {
    const body = await readJsonBody(request);
    const latest = getConfig(ledger);
    const result = await runFinnhubSync({
      config: latest.config,
      ledger,
      apiKey: process.env.FINNHUB_API_KEY ?? body.apiKey,
    });
    sendJson(response, 200, result);
    return;
  }

  if (method === "POST" && pathname === "/api/dry-run") {
    const body = await readJsonBody(request);
    const latest = getConfig(ledger);
    const dividendRecords = body.dividendRecords ?? ledger.listDividendRecords();
    const dryRun = buildDryRun({
      positions: body.positions ?? [],
      dividendRecords,
      config: body.config ?? latest.config,
      existingIdempotencyKeys: ledger.getSuccessfulIdempotencyKeys(),
    });
    const batchId = body.batchId ?? `batch-${new Date().toISOString().replace(/[-:.TZ]/gu, "")}-${randomUUID().slice(0, 8)}`;
    ledger.createBatch({
      id: batchId,
      source: body.source ?? "dry-run",
      status: dryRun.status,
      configVersionId: latest.id,
      configSnapshot: body.config ?? latest.config,
      operator: getOperator(request, body),
      reason: body.reason ?? "dry-run preview",
      summary: dryRun.summary,
    });
    ledger.saveAdjustmentPlans(batchId, dryRun);
    sendJson(response, 201, { batchId, ...dryRun });
    return;
  }

  if (method === "GET" && pathname === "/api/batches") {
    sendJson(response, 200, { batches: ledger.listBatches() });
    return;
  }

  const plansMatch = pathname.match(/^\/api\/batches\/([^/]+)\/plans$/u);
  if (method === "GET" && plansMatch) {
    sendJson(response, 200, { plans: ledger.listPlans(decodeURIComponent(plansMatch[1])) });
    return;
  }

  if (method === "POST" && pathname === "/api/audit-email/preview") {
    const body = await readJsonBody(request);
    const batch = ledger.getBatch(body.batchId);
    const plans = body.dryRun?.plans ?? (batch ? ledger.listPlans(batch.id) : []);
    const dryRun = body.dryRun ?? {
      plans,
      summary: batch?.summary ?? {},
      warnings: plans.flatMap((plan) => plan.warnings ?? []),
    };
    const email = composeAuditEmail({
      dryRun,
      batchId: body.batchId ?? "ad-hoc",
      previewUrl: body.previewUrl,
      source: body.source,
      recipients: body.recipients ?? getConfig(ledger).config.auditEmail?.recipients ?? [],
    });
    const mailId = ledger.recordMailNotification({
      batchId: body.batchId,
      type: "audit_preview",
      ...email,
      status: "preview",
    });
    sendJson(response, 200, { id: mailId, ...email });
    return;
  }

  const applyMatch = pathname.match(/^\/api\/batches\/([^/]+)\/apply$/u);
  if (method === "POST" && applyMatch) {
    if (process.env.DIVIDEND_UPLOADER_USE_MOCK_EXECUTION !== "1") {
      sendError(response, 409, "Real apply is disabled in this Node service. Set DIVIDEND_UPLOADER_USE_MOCK_EXECUTION=1 for local mock apply.");
      return;
    }
    const body = await readJsonBody(request);
    const batchId = decodeURIComponent(applyMatch[1]);
    const batch = ledger.getBatch(batchId);
    if (!batch) {
      sendError(response, 404, "Batch not found");
      return;
    }
    const plans = ledger.listPlans(batchId).map((plan) => ({ ...plan, batchId }));
    const result = await applyAdjustmentPlans({
      plans,
      managerApi: new MockExecutionAdapter(),
      ledger,
      throttle: batch.configSnapshot.applyThrottle,
      operator: getOperator(request, body),
      reason: body.reason ?? "mock apply",
    });
    sendJson(response, 200, result);
    return;
  }

  sendError(response, 404, "API route not found");
}

export function createDividendUploaderServer({ ledger = createLedger(), portalDataDir } = {}) {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    try {
      if (url.pathname.startsWith("/admin-api/")) {
        const handled = await routePluginPortal({ request, response, url, portalDataDir });
        if (handled) {
          return;
        }
      }
      if (url.pathname.startsWith("/api/")) {
        await routeApi({ request, response, ledger, url });
      } else {
        await serveStatic(request, response, url.pathname);
      }
    } catch (error) {
      sendError(response, 500, error.message);
    }
  });
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? process.env.DIVIDEND_UPLOADER_PORT ?? 4173);
  const host = process.env.DIVIDEND_UPLOADER_HOST ?? "127.0.0.1";
  const server = createDividendUploaderServer();
  server.listen(port, host, () => {
    console.log(`Dividend Uploader web service listening on http://${host}:${port}`);
  });
}
