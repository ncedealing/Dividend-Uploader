const state = {
  config: null,
  lastBatchId: null,
  portalToken: window.localStorage.getItem("du.portal.token") ?? "",
  portalActive: null,
  portalFiles: [],
  csvRows: [],
  products: [],
};

const samplePositions = [
  {
    platform: "mt5",
    login: 10001,
    group: "real\\VIP-A",
    ticket: 9001001,
    symbol: "AAPL.m",
    side: "buy",
    volumeLots: 1.2,
    currency: "USD",
  },
  {
    platform: "mt5",
    login: 10002,
    group: "real\\VIP-A",
    ticket: 9001002,
    symbol: "EURUSD.m",
    side: "sell",
    volumeLots: 0.5,
    currency: "USD",
  },
];

const sampleCsv = `mtSymbolMask,longInterestValue,shortInterestValue,groupMask,currency,remark
EURUSD*,2.5,-3.1,real\\\\*,USD,weekday update
XAUUSD*,8.2,-9.4,*,USD,metals update`;

const csvSchemas = {
  overnightInterest: {
    label: "Interest",
    columns: [
      ["mtSymbolMask", "Symbol mask"],
      ["longInterestValue", "Long value"],
      ["shortInterestValue", "Short value"],
      ["groupMask", "Group mask"],
      ["currency", "Currency"],
      ["remark", "Remark"],
    ],
    emptyRow: {
      mtSymbolMask: "",
      longInterestValue: "",
      shortInterestValue: "",
      groupMask: "*",
      currency: "USD",
      remark: "",
    },
  },
  dividend: {
    label: "Dividend",
    columns: [
      ["symbol", "Symbol"],
      ["exDate", "Ex-date"],
      ["dividendUnit", "Unit"],
      ["dividendPerShare", "Per share"],
      ["dividendPerLot", "Per lot"],
      ["currency", "Currency"],
      ["recordRatio", "Record ratio"],
      ["remark", "Remark"],
    ],
    emptyRow: {
      symbol: "",
      exDate: "",
      dividendUnit: "perShare",
      dividendPerShare: "",
      dividendPerLot: "",
      currency: "USD",
      recordRatio: "1",
      remark: "",
    },
  },
};

const tabMeta = {
  csvUpload: ["CSV Data", "Import, edit, export, then apply rows to the published JSON."],
  configuration: ["Configuration", "Manage low-change products, environment, time zone, execution, and sync settings."],
  pluginPortal: ["Plugin Sync", "Save the active JSON and expose it to MT4/MT5 plugins."],
  pluginStatus: ["Plugin Status", "View heartbeat feedback for the current active UUID."],
  dryrun: ["Preview", "Run the local preview workflow before applying anything."],
  history: ["History", "Review imported dividend rows and batch history."],
};

function element(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const node = element(id);
  if (node) {
    node.textContent = value;
  }
}

function setClassName(id, value) {
  const node = element(id);
  if (node) {
    node.className = value;
  }
}

function setSelectValue(id, value, label = value) {
  const select = element(id);
  if (!select) {
    return;
  }
  const normalized = String(value ?? "");
  if (normalized && !Array.from(select.options).some((option) => option.value === normalized)) {
    select.add(new Option(label, normalized));
  }
  select.value = normalized;
}

function toast(message) {
  const node = element("toast");
  node.textContent = message;
  node.classList.add("show");
  window.setTimeout(() => node.classList.remove("show"), 3200);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function normalizeBaseUrl(value) {
  const fallback = "https://test.appcdn002.com";
  try {
    const parsed = new URL((value || fallback).trim());
    parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return fallback;
  }
}

function timeZoneParts(date, timeZone) {
  let selectedTimeZone = timeZone || "UTC";
  if (selectedTimeZone === "auto-mt-server") {
    selectedTimeZone = "UTC";
  }
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: selectedTimeZone }).format(date);
  } catch {
    selectedTimeZone = "UTC";
  }
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: selectedTimeZone,
    hour12: false,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
}

function timeZoneOffsetMinutes(date, timeZone) {
  const parts = timeZoneParts(date, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === "24" ? "0" : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUtc - date.getTime()) / 60000;
}

function zonedInputToUtcIso(value, timeZone) {
  if (!value) {
    return new Date().toISOString();
  }
  const [datePart, timePart = "00:00"] = value.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let utc = new Date(localAsUtc - timeZoneOffsetMinutes(new Date(localAsUtc), timeZone) * 60000);
  utc = new Date(localAsUtc - timeZoneOffsetMinutes(utc, timeZone) * 60000);
  return utc.toISOString();
}

function isoToZonedInput(value, timeZone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const parts = timeZoneParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  const source = String(text ?? "").replace(/^\uFEFF/u, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '"' && quoted && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(value.trim());
      value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(value.trim());
      if (row.some((cell) => cell !== "")) {
        rows.push(row);
      }
      row = [];
      value = "";
    } else {
      value += char;
    }
  }
  row.push(value.trim());
  if (row.some((cell) => cell !== "")) {
    rows.push(row);
  }
  if (rows.length === 0) {
    return [];
  }
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((cells) =>
    Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])),
  );
}

function encodeCsvValue(value) {
  const text = String(value ?? "");
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function rowsToCsv(rows, columns) {
  const fields = columns.map(([field]) => field);
  return [
    fields.join(","),
    ...rows.map((row) => fields.map((field) => encodeCsvValue(row[field])).join(",")),
  ].join("\n");
}

function downloadText(filename, text, type = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function numberOrNull(value) {
  if (value === "" || value == null) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function csvRowsToDividendRecords(rows) {
  return rows.map((row, index) => {
    const symbol = row.productSymbol || row.displaySymbol || row.finnhubSymbol || row.symbol || row.mtSymbol || row.mtSymbolMask || "";
    const exDate = row.exDate || row.date || row.effectiveDate || "";
    const perShare = numberOrNull(row.dividendPerShare ?? row.amount ?? row.dividend);
    const perLot = numberOrNull(row.dividendPerLot);
    return {
      id: row.id || `csv:${symbol}:${exDate}:${perShare ?? perLot ?? index}`,
      source: "csv",
      symbol,
      productSymbol: symbol,
      displaySymbol: symbol,
      finnhubSymbol: symbol,
      exDate,
      dividendUnit: row.dividendUnit || (perLot == null ? "perShare" : "perLot"),
      dividendPerShare: perShare,
      dividendPerLot: perLot,
      currency: row.currency || "USD",
      recordRatio: numberOrNull(row.recordRatio) ?? 1,
      remark: row.remark || "",
      rawPayload: row,
    };
  });
}

function csvRowsToOvernightInterestRows(rows) {
  return rows.map((row) => ({
    mtSymbolMask: row.mtSymbolMask || row.symbol || row.mtSymbol || "",
    longInterestValue: numberOrNull(row.longInterestValue ?? row.long ?? row.longInterest),
    shortInterestValue: numberOrNull(row.shortInterestValue ?? row.short ?? row.shortInterest),
    groupMask: row.groupMask || row.group || "*",
    currency: row.currency || "",
    remark: row.remark || row.comment || "",
  }));
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-operator": element("operator")?.value || "web-operator",
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }
  return payload;
}

async function portalApi(path, { method = "GET", body } = {}) {
  const headers = { "content-type": "application/json" };
  if (state.portalToken) {
    headers.authorization = `Bearer ${state.portalToken}`;
  }
  const response = await fetch(path, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? `Portal request failed: ${response.status}`);
  }
  return payload;
}

function currentCsvSchema() {
  return csvSchemas[element("csvType").value] ?? csvSchemas.overnightInterest;
}

function normalizedCsvRows(rows, schema = currentCsvSchema()) {
  return rows.map((row) => ({
    ...schema.emptyRow,
    ...Object.fromEntries(schema.columns.map(([field]) => [field, row[field] ?? ""])),
  }));
}

function syncRawCsvFromTable() {
  const schema = currentCsvSchema();
  element("csvText").value = rowsToCsv(state.csvRows, schema.columns);
}

function updateCsvPreview() {
  const schema = currentCsvSchema();
  setText("csvPreview", `Rows: ${state.csvRows.length} · Type: ${schema.label}`);
  setText("csvModeStatus", schema.label);
}

function renderCsvTable() {
  const schema = currentCsvSchema();
  element("csvTableHead").innerHTML = `
    <tr>
      ${schema.columns.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join("")}
      <th></th>
    </tr>
  `;
  element("csvRows").innerHTML = state.csvRows
    .map(
      (row, index) => `
        <tr data-index="${index}">
          ${schema.columns
            .map(([field]) => `<td><input data-field="${field}" value="${escapeHtml(row[field] ?? "")}"></td>`)
            .join("")}
          <td><button data-action="delete-csv-row" type="button">Delete</button></td>
        </tr>
      `,
    )
    .join("");
  updateCsvPreview();
}

function loadCsvTextToTable(text = element("csvText").value) {
  const rows = parseCsv(text);
  state.csvRows = normalizedCsvRows(rows.length ? rows : [currentCsvSchema().emptyRow]);
  syncRawCsvFromTable();
  renderCsvTable();
}

function productFromMapping(mapping = {}, index = 0) {
  const symbol = mapping.displaySymbol || mapping.productSymbol || mapping.finnhubSymbol || mapping.mtSymbolMask || "";
  return {
    enabled: mapping.enabled !== false,
    id: mapping.id || `product-${index + 1}`,
    name: symbol || `Product ${index + 1}`,
    platform: mapping.platform || "both",
    mtSymbolMask: mapping.mtSymbolMask || "",
    currency: mapping.currency || "USD",
    contractSize: String(mapping.contractSize ?? 100),
    dividendRatio: String(mapping.dividendRatio ?? 1),
    groupMask: mapping.accountScope?.groupMasks || "*",
    remark: mapping.remark || "",
  };
}

function productToMapping(product) {
  const symbol = product.name || product.mtSymbolMask || product.id;
  return {
    id: product.id,
    enabled: Boolean(product.enabled),
    platform: product.platform || "both",
    mtSymbolMask: product.mtSymbolMask || "",
    productSymbol: symbol,
    displaySymbol: symbol,
    finnhubSymbol: symbol,
    contractSize: Number(product.contractSize) || 100,
    dividendUnit: "perShare",
    currency: product.currency || "USD",
    dividendRatio: Number(product.dividendRatio) || 1,
    longRatio: 1,
    shortRatio: 1,
    longMultiplier: 1,
    shortMultiplier: -1,
    taxRate: 0,
    priority: 100,
    accountScope: { groupMasks: product.groupMask || "*", loginMasks: "*" },
    remark: product.remark || "",
  };
}

function portalProducts(data) {
  if (Array.isArray(data?.productCatalog)) {
    return data.productCatalog.map((product, index) => ({
      ...productFromMapping({}, index),
      ...product,
      enabled: product.enabled !== false,
    }));
  }
  if (Array.isArray(data?.products?.items)) {
    return data.products.items.map((product, index) => ({
      ...productFromMapping({}, index),
      ...product,
      enabled: product.enabled !== false,
    }));
  }
  if (Array.isArray(data?.mappings)) {
    return data.mappings.map(productFromMapping);
  }
  return [];
}

function productMasksFromProducts(products = state.products) {
  return products
    .filter((product) => product.enabled !== false && product.mtSymbolMask)
    .map((product) => product.mtSymbolMask)
    .join(", ");
}

function renderProductRows(products = state.products) {
  state.products = products;
  element("productRows").innerHTML = products
    .map(
      (product, index) => `
        <tr data-index="${index}">
          <td><input type="checkbox" data-field="enabled" ${product.enabled !== false ? "checked" : ""}></td>
          <td><input data-field="id" value="${escapeHtml(product.id ?? "")}"></td>
          <td><input data-field="name" value="${escapeHtml(product.name ?? "")}"></td>
          <td>
            <select data-field="platform">
              <option value="both" ${product.platform === "both" ? "selected" : ""}>both</option>
              <option value="mt4" ${product.platform === "mt4" ? "selected" : ""}>mt4</option>
              <option value="mt5" ${product.platform === "mt5" ? "selected" : ""}>mt5</option>
            </select>
          </td>
          <td><input data-field="mtSymbolMask" value="${escapeHtml(product.mtSymbolMask ?? "")}"></td>
          <td><input data-field="currency" value="${escapeHtml(product.currency ?? "USD")}"></td>
          <td><input data-field="contractSize" type="number" step="0.01" value="${escapeHtml(product.contractSize ?? 100)}"></td>
          <td><input data-field="dividendRatio" type="number" step="0.01" value="${escapeHtml(product.dividendRatio ?? 1)}"></td>
          <td><input data-field="groupMask" value="${escapeHtml(product.groupMask ?? "*")}"></td>
          <td><input data-field="remark" value="${escapeHtml(product.remark ?? "")}"></td>
          <td><button data-action="delete-product" type="button">Delete</button></td>
        </tr>
      `,
    )
    .join("");
  element("productMasks").value = productMasksFromProducts(products);
  setText("productQuickStatus", String(products.length));
}

function readProductsFromTable() {
  const products = [];
  for (const row of element("productRows").querySelectorAll("tr")) {
    const product = {};
    for (const input of row.querySelectorAll("input, select")) {
      const field = input.dataset.field;
      product[field] = input.type === "checkbox" ? input.checked : input.value;
    }
    products.push(product);
  }
  state.products = products;
  element("productMasks").value = productMasksFromProducts(products);
  setText("productQuickStatus", String(products.length));
  return products;
}

function renderConfig(config) {
  state.config = config;
  const reviewMode = config.reviewPolicy?.mode ?? "threshold";
  if (element("globalRatio")) {
    element("globalRatio").value = config.globalCalculation?.globalDividendRatio ?? 1;
  }
  if (element("reviewMode")) {
    element("reviewMode").value = reviewMode;
  }
  if (element("intervalSeconds")) {
    element("intervalSeconds").value = config.applyThrottle?.intervalSeconds ?? 0.2;
  }
  if (!state.products.length) {
    renderProductRows((config.mappings ?? []).map(productFromMapping));
  }
}

function renderDividendRows(records) {
  element("dividendRows").innerHTML = records
    .map(
      (record) => `
        <tr>
          <td>${escapeHtml(record.productSymbol ?? record.displaySymbol ?? record.symbol ?? record.finnhubSymbol ?? "")}</td>
          <td>${escapeHtml(record.exDate ?? "")}</td>
          <td>${escapeHtml(record.dividendUnit ?? "")}</td>
          <td>${escapeHtml(record.dividendPerShare ?? record.dividendPerLot ?? "")}</td>
          <td>${escapeHtml(record.currency ?? "")}</td>
        </tr>
      `,
    )
    .join("");
}

function renderDryRun(result) {
  state.lastBatchId = result.batchId;
  const summary = result.summary ?? {};
  element("dryRunSummary").textContent = `Batch ${result.batchId}: ${result.status}, orders ${summary.orderCount}, accounts ${summary.accountCount}, total ${summary.totalAmount}, warnings ${summary.warningCount}`;
  element("planRows").innerHTML = (result.plans ?? [])
    .map(
      (plan) => `
        <tr>
          <td>${escapeHtml(plan.platform)}</td>
          <td>${escapeHtml(plan.login)}</td>
          <td>${escapeHtml(plan.ticket)}</td>
          <td>${escapeHtml(plan.symbol)}</td>
          <td>${escapeHtml(plan.side)}</td>
          <td>${escapeHtml(plan.volumeLots)}</td>
          <td>${escapeHtml(plan.matchedProductMask)}</td>
          <td>${escapeHtml(plan.mappingRuleId)}</td>
          <td>${escapeHtml(plan.adjustedPerLot)}</td>
          <td>${escapeHtml(plan.taxRate)}</td>
          <td>${escapeHtml(plan.finalAmount)} ${escapeHtml(plan.currency)}</td>
          <td>${escapeHtml((plan.warnings ?? []).map((warning) => warning.code).join(", "))}</td>
        </tr>
      `,
    )
    .join("");
}

function renderBatches(batches) {
  element("batchRows").innerHTML = batches
    .map(
      (batch) => `
        <tr>
          <td>${escapeHtml(batch.id)}</td>
          <td>${escapeHtml(batch.status)}</td>
          <td>${escapeHtml(batch.summary?.orderCount ?? 0)}</td>
          <td>${escapeHtml(batch.summary?.totalAmount ?? 0)}</td>
          <td>${escapeHtml(batch.operator)}</td>
          <td>${escapeHtml(batch.createdAt)}</td>
        </tr>
      `,
    )
    .join("");
}

function defaultPortalData() {
  const baseUrl = normalizeBaseUrl(element("portalBaseUrl").value);
  const businessTimezone = element("portalBusinessTimezone").value || "Asia/Shanghai";
  const serverTimezone = element("portalServerTimezone").value || "auto-mt-server";
  const effectiveFromLocal = element("portalEffectiveFrom").value || isoToZonedInput(new Date().toISOString(), businessTimezone);
  const effectiveFromUtc = zonedInputToUtcIso(effectiveFromLocal, businessTimezone);
  const products = readProductsFromTable();
  return {
    pluginName: "Dividend Uploader",
    domain: baseUrl,
    publicBasePath: "/admin-api/dividend-uploader-public",
    feedbackPath: "/admin-api/dividend-uploader-feedback",
    targetContext: {
      platform: element("portalPlatform").value,
      serverId: element("portalServerId").value || "select-on-page",
      effectiveFromLocal,
      effectiveFromTimezone: businessTimezone,
      effectiveFromUtc,
      effectiveFrom: effectiveFromUtc,
    },
    remoteSync: {
      baseUrl,
      publicBasePath: "/admin-api/dividend-uploader-public",
      feedbackPath: "/admin-api/dividend-uploader-feedback",
      metadataIntervalSeconds: 300,
      heartbeatIntervalSeconds: 300,
      metadataFile: "active-meta.json",
      fullConfigFile: "active.json",
    },
    timeSync: {
      businessTimezone,
      serverTimezone,
      serverTimezoneMode: serverTimezone === "auto-mt-server" ? "auto" : "manual",
      pluginTimezoneSource: serverTimezone === "auto-mt-server" ? "mt-server" : "manual",
      effectiveTimeMode: "business-timezone",
      publishTimestamps: "utc",
      requirePluginUtcClock: true,
      maxClockDriftSeconds: 120,
    },
    productCatalog: products,
    products: { items: products },
    mappings: products.map(productToMapping),
    dividendProductMasks: productMasksFromProducts(products),
    overnightInterest: {
      updateFields: ["longInterestValue", "shortInterestValue"],
      csvRequiredColumns: ["mtSymbolMask", "longInterestValue", "shortInterestValue"],
      csvOptionalColumns: ["groupMask", "currency", "remark"],
      pageContextRequired: ["platform", "serverId", "effectiveFrom"],
      readOnlyContextFields: ["interestMode", "tripleDay"],
    },
    mt4Plugin: {
      enabled: true,
      feedbackServerLabel: "MT4-DividendUploader",
      timezoneSource: "server",
    },
    mt5Plugin: {
      enabled: true,
      feedbackServerLabel: "MT5-DividendUploader",
      timezoneSource: "server",
    },
  };
}

function statusQuickLabel(status = {}) {
  if (status.label === "Plugin connected") return "Connected";
  if (status.label === "Login required") return "Login";
  if (status.label === "No active configuration") return "No config";
  if (status.label === "Waiting for plugin load") return "Waiting";
  if (status.label === "Connection stale") return "Stale";
  if (status.label === "Plugin reported an error") return "Error";
  return status.label ?? "Waiting";
}

function renderPortalStatus(status = {}) {
  const stateClass = status.state === "ok" ? "ok" : status.state === "error" ? "error" : "neutral";
  const quickLabel = statusQuickLabel(status);
  setClassName("portalStatusDot", `dot ${stateClass}`);
  setText("portalStatusLabel", status.label ?? "No active configuration");
  setText("portalStatusDetail", status.detail ?? "");
  setClassName("portalStatusDotMirror", `dot ${stateClass}`);
  setText("portalStatusLabelMirror", status.label ?? "No active configuration");
  setText("portalStatusDetailMirror", status.detail ?? "");
  setClassName("headerPluginDot", `dot ${stateClass}`);
  setText("pluginQuickStatus", quickLabel);
  setText("pluginQuickDetail", status.detail || "No heartbeat");
  const card = element("linkStatusCard");
  if (card) {
    card.dataset.state = stateClass;
  }
}

function renderPortalIntegration(integration = {}) {
  setText("portalMetaUrl", integration.activeMetaUrl ?? "");
  setText("portalActiveUrl", integration.activeConfigUrl ?? "");
  setText("portalFeedbackUrl", integration.feedbackUrl ?? "");
  setText("portalCurrentUuid", integration.currentUuid ?? "");
  setText("configQuickStatus", integration.currentUuid ? integration.currentUuid.slice(0, 8) : "No UUID");
}

function renderPortalFiles(files = []) {
  state.portalFiles = files;
  element("portalFiles").innerHTML =
    files
      .map(
        (file) => `
          <div class="file-card">
            <strong>${escapeHtml(file.filename)}${file.enabled ? " · active" : ""}</strong>
            <small>UUID ${escapeHtml(file.uuid ?? "-")}</small>
            <small>Updated ${escapeHtml(file.updated_at ?? "-")}</small>
          </div>
        `,
      )
      .join("") || '<div class="file-card"><small>No saved config files yet.</small></div>';
}

function renderPortalFeedback(records = []) {
  element("portalFeedback").innerHTML =
    records
      .map(
        (record) => `
          <div class="feedback-card ${record.is_current_uuid ? "current" : ""}">
            <strong>${escapeHtml(record.status)} · ${escapeHtml(record.mode || "feedback")}</strong>
            <small>${escapeHtml(record.received_at)} · UUID ${escapeHtml(record.uuid)}</small>
            <small>${escapeHtml(record.server || "-")} ${escapeHtml(record.account || "")} ${escapeHtml(record.plugin_version || "")}</small>
            <small>${escapeHtml(record.message || "")}</small>
          </div>
        `,
      )
      .join("") || '<div class="feedback-card"><small>No plugin feedback yet.</small></div>';
}

function renderPortalConfig(payload) {
  state.portalActive = payload.active ?? null;
  const active = payload.active;
  const data = active?.data ?? payload.defaultData ?? defaultPortalData();
  const baseUrl = data.remoteSync?.baseUrl ?? data.domain ?? "https://test.appcdn002.com";
  const businessTimezone = data.timeSync?.businessTimezone ?? data.targetContext?.effectiveFromTimezone ?? "Asia/Shanghai";
  element("portalBaseUrl").value = baseUrl;
  setSelectValue("portalBusinessTimezone", businessTimezone);
  setSelectValue("portalServerTimezone", data.timeSync?.serverTimezone ?? "auto-mt-server");
  setSelectValue("portalPlatform", data.targetContext?.platform ?? "both");
  element("portalServerId").value = data.targetContext?.serverId ?? "select-on-page";
  if (active) {
    element("portalJson").value = JSON.stringify(data, null, 2);
  } else if (!element("portalJson").value.trim()) {
    element("portalJson").value = JSON.stringify(data, null, 2);
  }
  const products = portalProducts(data);
  if (products.length) {
    renderProductRows(products);
  }
  const target = data.targetContext ?? {};
  if (target.effectiveFromLocal) {
    element("portalEffectiveFrom").value = target.effectiveFromLocal;
  } else if (target.effectiveFromUtc || target.effectiveFrom || active?.updated_at) {
    element("portalEffectiveFrom").value = isoToZonedInput(target.effectiveFromUtc ?? target.effectiveFrom ?? active.updated_at, businessTimezone);
  }
  renderPortalStatus(payload.status);
  renderPortalIntegration(payload.integration);
  renderPortalFiles(payload.files ?? []);
}

async function loadPortal() {
  if (!state.portalToken) {
    renderPortalStatus({ state: "neutral", label: "Login required", detail: "Enter admin credentials to load portal data." });
    return;
  }
  const payload = await portalApi("/admin-api/dividend-uploader-configs");
  renderPortalConfig(payload);
  const feedback = await portalApi("/admin-api/dividend-uploader-feedback?limit=20");
  renderPortalStatus(feedback.status);
  renderPortalFeedback(feedback.records);
}

function currentPortalJson() {
  try {
    return JSON.parse(element("portalJson").value || "{}");
  } catch {
    return defaultPortalData();
  }
}

function portalConfigFromForm() {
  const data = {
    ...defaultPortalData(),
    ...currentPortalJson(),
  };
  const products = readProductsFromTable();
  const baseUrl = normalizeBaseUrl(element("portalBaseUrl").value);
  const businessTimezone = element("portalBusinessTimezone").value || "Asia/Shanghai";
  const serverTimezone = element("portalServerTimezone").value || "auto-mt-server";
  const effectiveFromLocal = element("portalEffectiveFrom").value || isoToZonedInput(new Date().toISOString(), businessTimezone);
  const effectiveFromUtc = zonedInputToUtcIso(effectiveFromLocal, businessTimezone);
  data.domain = baseUrl;
  data.publicBasePath = data.remoteSync?.publicBasePath ?? data.publicBasePath ?? "/admin-api/dividend-uploader-public";
  data.feedbackPath = data.remoteSync?.feedbackPath ?? data.feedbackPath ?? "/admin-api/dividend-uploader-feedback";
  data.remoteSync = {
    ...(data.remoteSync ?? {}),
    baseUrl,
    publicBasePath: data.publicBasePath,
    feedbackPath: data.feedbackPath,
    metadataFile: data.remoteSync?.metadataFile ?? "active-meta.json",
    fullConfigFile: data.remoteSync?.fullConfigFile ?? "active.json",
    metadataIntervalSeconds: Number(data.remoteSync?.metadataIntervalSeconds ?? 300),
    heartbeatIntervalSeconds: Number(data.remoteSync?.heartbeatIntervalSeconds ?? 300),
  };
  data.timeSync = {
    ...(data.timeSync ?? {}),
    businessTimezone,
    serverTimezone,
    serverTimezoneMode: serverTimezone === "auto-mt-server" ? "auto" : "manual",
    pluginTimezoneSource: serverTimezone === "auto-mt-server" ? "mt-server" : "manual",
    effectiveTimeMode: "business-timezone",
    publishTimestamps: "utc",
    requirePluginUtcClock: data.timeSync?.requirePluginUtcClock ?? true,
    maxClockDriftSeconds: Number(data.timeSync?.maxClockDriftSeconds ?? 120),
  };
  data.targetContext = {
    ...(data.targetContext ?? {}),
    platform: element("portalPlatform").value,
    serverId: element("portalServerId").value || "select-on-page",
    effectiveFromLocal,
    effectiveFromTimezone: businessTimezone,
    effectiveFromUtc,
    effectiveFrom: effectiveFromUtc,
  };
  data.productCatalog = products;
  data.products = { ...(data.products ?? {}), items: products };
  data.mappings = products.map(productToMapping);
  data.dividendProductMasks = productMasksFromProducts(products);
  data.mt4Plugin = { ...(data.mt4Plugin ?? {}), timezoneSource: "server" };
  data.mt5Plugin = { ...(data.mt5Plugin ?? {}), timezoneSource: "server" };
  return data;
}

function applyRowsToPortalJson() {
  const data = portalConfigFromForm();
  if (element("csvType").value === "overnightInterest") {
    const updates = csvRowsToOvernightInterestRows(state.csvRows);
    const invalid = updates.filter((row) => !row.mtSymbolMask || row.longInterestValue == null || row.shortInterestValue == null);
    if (invalid.length) {
      throw new Error("Overnight interest CSV requires mtSymbolMask,longInterestValue,shortInterestValue");
    }
    data.overnightInterest = {
      ...(data.overnightInterest ?? {}),
      updateFields: ["longInterestValue", "shortInterestValue"],
      valueUpdates: updates,
      source: {
        type: "csv",
        importedAt: new Date().toISOString(),
        rowCount: updates.length,
      },
    };
  } else {
    const records = csvRowsToDividendRecords(state.csvRows);
    data.dividend = {
      ...(data.dividend ?? {}),
      enabled: true,
      executionMode: "server-plugin-json-sync",
      records,
      source: {
        type: "csv",
        importedAt: new Date().toISOString(),
        rowCount: records.length,
      },
    };
  }
  element("portalJson").value = JSON.stringify(data, null, 2);
  updateCsvPreview();
}

async function loadAll() {
  const health = await api("/api/health");
  setText("healthStatus", health.ok ? "Online" : "Offline");
  setClassName("healthStatus", health.ok ? "status-ok" : "status-error");
  const config = await api("/api/config");
  renderConfig(config.config);
  const dividends = await api("/api/dividends");
  renderDividendRows(dividends.records);
  const batches = await api("/api/batches");
  renderBatches(batches.batches);
  await loadPortal().catch((error) => renderPortalStatus({ state: "neutral", label: "Portal not loaded", detail: error.message }));
}

function activateTab(tabId) {
  for (const panel of document.querySelectorAll(".tab-panel")) {
    panel.hidden = panel.id !== tabId;
  }
  for (const button of document.querySelectorAll(".tab-button")) {
    button.classList.toggle("active", button.dataset.tab === tabId);
  }
  const [title, subtitle] = tabMeta[tabId] ?? tabMeta.csvUpload;
  setText("pageTitle", title);
  setText("pageSubtitle", subtitle);
  if (window.location.hash !== `#${tabId}`) {
    history.replaceState(null, "", `#${tabId}`);
  }
}

function normalizeTabId(tabId) {
  return tabId === "products" ? "configuration" : tabId;
}

function activateConfigTab(tabId) {
  const panel = element(tabId);
  const section = panel?.closest(".config-section");
  if (!section) {
    return;
  }
  for (const item of section.querySelectorAll(".config-tab-panel")) {
    item.hidden = item.id !== tabId;
  }
  for (const button of section.querySelectorAll(".config-tab-button")) {
    button.classList.toggle("active", button.dataset.configTab === tabId);
  }
}

function activateConfigSection(sectionId) {
  const section = element(sectionId);
  if (!section) {
    return;
  }
  for (const item of document.querySelectorAll(".config-section")) {
    item.hidden = item.id !== sectionId;
  }
  for (const button of document.querySelectorAll(".config-menu-button")) {
    button.classList.toggle("active", button.dataset.configSection === sectionId);
  }
  const activeTab = section.querySelector(".config-tab-button.active") ?? section.querySelector(".config-tab-button");
  if (activeTab) {
    activateConfigTab(activeTab.dataset.configTab);
  }
}

element("positionsJson").value = JSON.stringify(samplePositions, null, 2);
element("csvText").value = sampleCsv;
loadCsvTextToTable(sampleCsv);

document.querySelector(".main-nav").addEventListener("click", (event) => {
  const button = event.target.closest(".tab-button");
  if (button) {
    activateTab(button.dataset.tab);
  }
});

document.querySelector(".configuration-layout")?.addEventListener("click", (event) => {
  const sectionButton = event.target.closest(".config-menu-button");
  if (sectionButton) {
    activateConfigSection(sectionButton.dataset.configSection);
    return;
  }
  const tabButton = event.target.closest(".config-tab-button");
  if (tabButton) {
    activateConfigTab(tabButton.dataset.configTab);
  }
});

element("loadConfig").addEventListener("click", () => loadAll().catch((error) => toast(error.message)));
element("csvType").addEventListener("change", () => {
  state.csvRows = [currentCsvSchema().emptyRow];
  syncRawCsvFromTable();
  renderCsvTable();
});

element("csvRows").addEventListener("input", (event) => {
  const input = event.target.closest("input");
  if (!input) return;
  const row = input.closest("tr");
  state.csvRows[Number(row.dataset.index)][input.dataset.field] = input.value;
  syncRawCsvFromTable();
  updateCsvPreview();
});

element("csvRows").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action='delete-csv-row']");
  if (!button) return;
  state.csvRows.splice(Number(button.closest("tr").dataset.index), 1);
  syncRawCsvFromTable();
  renderCsvTable();
});

element("addCsvRow").addEventListener("click", () => {
  state.csvRows.push({ ...currentCsvSchema().emptyRow });
  syncRawCsvFromTable();
  renderCsvTable();
});

element("loadRawCsv").addEventListener("click", () => loadCsvTextToTable());

element("csvFile").addEventListener("change", async (event) => {
  const [file] = event.target.files ?? [];
  if (!file) return;
  loadCsvTextToTable(await file.text());
  toast(`${file.name} loaded`);
});

element("applyCsvToJson").addEventListener("click", () => {
  try {
    applyRowsToPortalJson();
    toast(`Applied ${state.csvRows.length} CSV rows to JSON`);
  } catch (error) {
    toast(error.message);
  }
});

element("exportCsv").addEventListener("click", () => {
  const schema = currentCsvSchema();
  downloadText(`${element("csvType").value}.csv`, rowsToCsv(state.csvRows, schema.columns));
});

element("productRows").addEventListener("input", () => readProductsFromTable());
element("productRows").addEventListener("change", () => readProductsFromTable());
element("productRows").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action='delete-product']");
  if (!button) return;
  readProductsFromTable();
  state.products.splice(Number(button.closest("tr").dataset.index), 1);
  renderProductRows(state.products);
});

element("addProduct").addEventListener("click", () => {
  readProductsFromTable();
  state.products.push(productFromMapping({ id: `product-${Date.now()}`, mtSymbolMask: "NEW*", displaySymbol: "NEW" }, state.products.length));
  renderProductRows(state.products);
});

element("exportProductsCsv").addEventListener("click", () => {
  readProductsFromTable();
  downloadText(
    "product-list.csv",
    rowsToCsv(state.products, [
      ["enabled", "enabled"],
      ["id", "id"],
      ["name", "name"],
      ["platform", "platform"],
      ["mtSymbolMask", "mtSymbolMask"],
      ["currency", "currency"],
      ["contractSize", "contractSize"],
      ["dividendRatio", "dividendRatio"],
      ["groupMask", "groupMask"],
      ["remark", "remark"],
    ]),
  );
});

element("productCsvFile").addEventListener("change", async (event) => {
  const [file] = event.target.files ?? [];
  if (!file) return;
  const rows = parseCsv(await file.text());
  state.products = rows.map((row, index) => ({
    enabled: String(row.enabled ?? "true").toLowerCase() !== "false",
    id: row.id || `product-${index + 1}`,
    name: row.name || row.displaySymbol || row.productSymbol || row.finnhubSymbol || row.mtSymbolMask || "",
    platform: row.platform || "both",
    mtSymbolMask: row.mtSymbolMask || row.symbol || "",
    currency: row.currency || "USD",
    contractSize: row.contractSize || "100",
    dividendRatio: row.dividendRatio || "1",
    groupMask: row.groupMask || "*",
    remark: row.remark || "",
  }));
  renderProductRows(state.products);
  toast(`${file.name} loaded`);
});

element("runDryRun").addEventListener("click", async () => {
  const positions = JSON.parse(element("positionsJson").value);
  const result = await api("/api/dry-run", {
    method: "POST",
    body: { positions, reason: "operator dry-run preview" },
  });
  renderDryRun(result);
  await loadAll();
});

element("previewEmail").addEventListener("click", async () => {
  if (!state.lastBatchId) {
    toast("Run dry-run first");
    return;
  }
  const email = await api("/api/audit-email/preview", {
    method: "POST",
    body: { batchId: state.lastBatchId, previewUrl: window.location.href },
  });
  toast(`Audit email preview created: ${email.subject}`);
});

element("mockApply").addEventListener("click", async () => {
  if (!state.lastBatchId) {
    toast("Run dry-run first");
    return;
  }
  const result = await api(`/api/batches/${encodeURIComponent(state.lastBatchId)}/apply`, {
    method: "POST",
    body: { reason: "UI mock apply" },
  });
  toast(`Mock apply success ${result.successCount}, failed ${result.failureCount}`);
  await loadAll();
});

element("loadBatches").addEventListener("click", async () => {
  const batches = await api("/api/batches");
  renderBatches(batches.batches);
});

element("portalLoginButton").addEventListener("click", async () => {
  const login = await portalApi("/admin-api/login", {
    method: "POST",
    body: {
      username: element("portalUsername").value,
      password: element("portalPassword").value,
    },
  });
  state.portalToken = login.token;
  window.localStorage.setItem("du.portal.token", login.token);
  element("portalLoginStatus").textContent = login.mustChangePassword ? "Logged in; change temporary password before production use." : "Logged in";
  await loadPortal();
});

element("portalLoad").addEventListener("click", () => loadPortal().catch((error) => toast(error.message)));
element("portalRefreshFiles").addEventListener("click", () => loadPortal().catch((error) => toast(error.message)));
element("portalRefreshFeedback").addEventListener("click", async () => {
  const feedback = await portalApi("/admin-api/dividend-uploader-feedback?limit=20");
  renderPortalStatus(feedback.status);
  renderPortalFeedback(feedback.records);
});
element("portalSave").addEventListener("click", async () => {
  const saved = await portalApi("/admin-api/dividend-uploader-configs", {
    method: "POST",
    body: {
      filename: element("portalFilename").value,
      enabled: true,
      data: portalConfigFromForm(),
    },
  });
  const reread = await portalApi(`/admin-api/dividend-uploader-configs/${encodeURIComponent(saved.filename)}`);
  element("portalJson").value = JSON.stringify(reread.content.data, null, 2);
  toast(`Portal config saved with UUID ${saved.content.uuid}`);
  await loadPortal();
});
element("portalEnable").addEventListener("click", async () => {
  const filename = element("portalFilename").value;
  await portalApi(`/admin-api/dividend-uploader-configs/${encodeURIComponent(filename)}/enable`, { method: "PUT" });
  toast("Portal config enabled");
  await loadPortal();
});

window.addEventListener("hashchange", () => {
  const tabId = normalizeTabId(window.location.hash.replace("#", "") || "csvUpload");
  activateTab(tabMeta[tabId] ? tabId : "csvUpload");
});

activateConfigSection("configProducts");
const initialTabId = normalizeTabId(window.location.hash.replace("#", "") || "csvUpload");
activateTab(tabMeta[initialTabId] ? initialTabId : "csvUpload");
loadAll().catch((error) => toast(error.message));
