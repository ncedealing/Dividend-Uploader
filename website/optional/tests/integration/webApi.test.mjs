import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { createDividendUploaderServer } from "../../../src/web/api/server.mjs";
import { SqliteLedger } from "../../../src/storage/repositories/SqliteLedger.mjs";

class MockRequest extends Readable {
  constructor({ method = "GET", url = "/", body = null, headers = {} }) {
    super();
    this.method = method;
    this.url = url;
    this.headers = { host: "localhost", ...headers };
    this.body = body == null ? null : Buffer.from(JSON.stringify(body));
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
      // Static responses are not JSON.
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

test("web API supports config, dividend import, and dry-run without listening on a port", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dividend-uploader-api-"));
  const ledger = new SqliteLedger(join(dir, "ledger.db"));
  ledger.migrate();
  const server = createDividendUploaderServer({ ledger });

  const health = await request(server, { method: "GET", url: "/api/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.body.ok, true);

  const configResponse = await request(server, { method: "GET", url: "/api/config" });
  assert.equal(configResponse.statusCode, 200);
  assert.equal(configResponse.body.config.mappings.length > 0, true);

  const importResponse = await request(server, {
    method: "POST",
    url: "/api/dividends/import",
    body: {
      records: [
        {
          id: "manual:AAPL:2026-06-10:0.24",
          source: "manual",
          finnhubSymbol: "AAPL",
          exDate: "2026-06-10",
          dividendUnit: "perShare",
          dividendPerShare: 0.24,
          currency: "USD",
        },
      ],
    },
  });
  assert.equal(importResponse.statusCode, 201);
  assert.equal(importResponse.body.count, 1);

  const dryRunResponse = await request(server, {
    method: "POST",
    url: "/api/dry-run",
    body: {
      positions: [
        {
          platform: "mt5",
          login: 10001,
          group: "real\\VIP",
          ticket: 9001,
          symbol: "AAPL.m",
          side: "buy",
          volumeLots: 1,
          currency: "USD",
        },
      ],
    },
  });
  assert.equal(dryRunResponse.statusCode, 201);
  assert.equal(dryRunResponse.body.plans.length, 1);
  assert.equal(dryRunResponse.body.plans[0].mappingRuleId, "map-aapl-default");

  ledger.close();
});
