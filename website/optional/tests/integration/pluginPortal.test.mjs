import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { createDividendUploaderServer } from "../../../src/web/api/server.mjs";
import { SqliteLedger } from "../../../src/storage/repositories/SqliteLedger.mjs";

class MockRequest extends Readable {
  constructor({ method = "GET", url = "/", body = null, headers = {}, rawBody = null }) {
    super();
    this.method = method;
    this.url = url;
    this.headers = { host: "localhost", ...headers };
    this.body = rawBody ?? (body == null ? null : Buffer.from(JSON.stringify(body)));
  }

  _read() {
    if (this.body) {
      this.push(this.body);
      this.body = null;
    }
    this.push(null);
  }
}

class MockResponse extends Writable {
  constructor(resolve) {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
    this.resolve = resolve;
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = { ...this.headers, ...headers };
  }

  _write(chunk, encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  end(chunk) {
    if (chunk) {
      this.chunks.push(Buffer.from(chunk));
    }
    const bodyText = Buffer.concat(this.chunks).toString("utf8");
    let body = bodyText;
    try {
      body = JSON.parse(bodyText);
    } catch {
      // Non-JSON static response.
    }
    this.resolve({ statusCode: this.statusCode, headers: this.headers, body, bodyText });
    super.end();
  }
}

function request(server, options) {
  return new Promise((resolve) => {
    server.emit("request", new MockRequest(options), new MockResponse(resolve));
  });
}

test("plugin portal protects management, exposes active JSON, rotates UUID, and records current feedback only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dividend-uploader-portal-"));
  const ledger = new SqliteLedger(join(dir, "ledger.db"));
  ledger.migrate();
  process.env.DIVIDEND_UPLOADER_ADMIN_USER = "admin";
  process.env.DIVIDEND_UPLOADER_ADMIN_PASSWORD = "temporary-password";
  const server = createDividendUploaderServer({ ledger, portalDataDir: join(dir, "portal") });

  const blocked = await request(server, { method: "GET", url: "/admin-api/dividend-uploader-configs" });
  assert.equal(blocked.statusCode, 401);

  const login = await request(server, {
    method: "POST",
    url: "/admin-api/login",
    body: { username: "admin", password: "temporary-password" },
  });
  assert.equal(login.statusCode, 200);
  const token = login.body.token;
  assert.equal(typeof token, "string");
  const auth = { authorization: `Bearer ${token}` };

  const firstSave = await request(server, {
    method: "POST",
    url: "/admin-api/dividend-uploader-configs",
    headers: auth,
    body: {
      filename: "remote-main.json",
      data: {
        pluginName: "Dividend Uploader",
        remoteSync: {
          baseUrl: "https://portal.example.net",
          publicBasePath: "/admin-api/dividend-uploader-public",
          feedbackPath: "/admin-api/dividend-uploader-feedback",
        },
        timeSync: {
          businessTimezone: "Europe/Limassol",
          serverTimezone: "UTC",
          effectiveTimeMode: "business-timezone",
        },
        targetContext: {
          platform: "both",
          serverId: "page-selected",
          effectiveFromLocal: "2026-07-14T03:00",
          effectiveFromTimezone: "Europe/Limassol",
          effectiveFromUtc: "2026-07-14T00:00:00.000Z",
          effectiveFrom: "2026-07-14T00:00:00.000Z",
        },
        overnightInterest: { updateFields: ["longInterestValue", "shortInterestValue"] },
      },
    },
  });
  assert.equal(firstSave.statusCode, 201);
  const firstUuid = firstSave.body.content.uuid;
  assert.match(firstUuid, /^[0-9a-f-]{36}$/u);

  const meta = await request(server, { method: "GET", url: "/admin-api/dividend-uploader-public/active-meta.json" });
  assert.equal(meta.statusCode, 200);
  assert.deepEqual(Object.keys(meta.body).sort(), ["updated_at", "uuid"]);
  assert.equal(meta.body.uuid, firstUuid);
  assert.match(meta.headers["cache-control"], /no-store/u);

  const active = await request(server, { method: "GET", url: "/admin-api/dividend-uploader-public/active.json" });
  assert.equal(active.statusCode, 200);
  assert.equal(active.body.uuid, firstUuid);
  assert.equal(active.body.data.pluginName, "Dividend Uploader");
  assert.equal(active.body.data.remoteSync.baseUrl, "https://portal.example.net");
  assert.equal(active.body.data.timeSync.businessTimezone, "Europe/Limassol");

  const configList = await request(server, {
    method: "GET",
    url: "/admin-api/dividend-uploader-configs",
    headers: auth,
  });
  assert.equal(configList.statusCode, 200);
  assert.equal(
    configList.body.integration.activeMetaUrl,
    "https://portal.example.net/admin-api/dividend-uploader-public/active-meta.json",
  );
  assert.equal(configList.body.integration.businessTimezone, "Europe/Limassol");

  const feedback = await request(server, {
    method: "GET",
    url: `/admin-api/dividend-uploader-feedback?uuid=${firstUuid}&filename=active.json&status=read&mode=full-read&server=MT5-Test&plugin_version=0.1.0`,
  });
  assert.equal(feedback.statusCode, 200);
  assert.equal(feedback.body.ok, true);

  const feedbackList = await request(server, {
    method: "GET",
    url: "/admin-api/dividend-uploader-feedback?limit=20",
    headers: auth,
  });
  assert.equal(feedbackList.statusCode, 200);
  assert.equal(feedbackList.body.status.state, "ok");
  assert.equal(feedbackList.body.records[0].uuid, firstUuid);

  const secondSave = await request(server, {
    method: "POST",
    url: "/admin-api/dividend-uploader-configs",
    headers: auth,
    body: {
      filename: "remote-main.json",
      data: {
        pluginName: "Dividend Uploader",
        targetContext: { platform: "mt5", serverId: "page-selected", effectiveFrom: "2026-07-15T00:00:00.000Z" },
        overnightInterest: { updateFields: ["longInterestValue", "shortInterestValue"] },
      },
    },
  });
  assert.equal(secondSave.statusCode, 201);
  const secondUuid = secondSave.body.content.uuid;
  assert.notEqual(secondUuid, firstUuid);

  const afterSecondSave = await request(server, {
    method: "GET",
    url: "/admin-api/dividend-uploader-feedback?limit=20",
    headers: auth,
  });
  assert.equal(afterSecondSave.body.status.state, "neutral");

  const oldFeedback = await request(server, {
    method: "GET",
    url: `/admin-api/dividend-uploader-feedback?uuid=${firstUuid}&filename=active.json&status=connected&mode=connect-check&server=MT4-Old`,
  });
  assert.equal(oldFeedback.statusCode, 200);

  const afterOldFeedback = await request(server, {
    method: "GET",
    url: "/admin-api/dividend-uploader-feedback?limit=20",
    headers: auth,
  });
  assert.equal(afterOldFeedback.body.activeUuid, secondUuid);
  assert.equal(afterOldFeedback.body.status.state, "neutral");

  const invalidStatus = await request(server, {
    method: "GET",
    url: `/admin-api/dividend-uploader-feedback?uuid=${secondUuid}&status=surprise`,
  });
  assert.equal(invalidStatus.statusCode, 400);

  const versionNoAuth = await request(server, { method: "GET", url: "/admin-api/version" });
  assert.equal(versionNoAuth.statusCode, 401);

  const version = await request(server, { method: "GET", url: "/admin-api/version", headers: auth });
  assert.equal(version.statusCode, 200);
  assert.equal(version.body.slug, "dividend-uploader");

  const upgradeNoAuth = await request(server, {
    method: "POST",
    url: "/admin-api/upgrade",
    rawBody: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    headers: { "x-upgrade-filename": "portal-upgrade.zip" },
  });
  assert.equal(upgradeNoAuth.statusCode, 401);

  const upgrade = await request(server, {
    method: "POST",
    url: "/admin-api/upgrade",
    rawBody: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    headers: { ...auth, "x-upgrade-filename": "portal-upgrade.zip" },
  });
  assert.equal(upgrade.statusCode, 200);
  assert.equal(upgrade.body.ok, true);
  assert.equal(upgrade.body.restartRequired, true);

  const postUpgradeMeta = await request(server, { method: "GET", url: "/admin-api/dividend-uploader-public/active-meta.json" });
  assert.equal(postUpgradeMeta.body.uuid, secondUuid);

  ledger.close();
});
