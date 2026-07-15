import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteLedger } from "../../../src/storage/repositories/SqliteLedger.mjs";
import { buildDryRun } from "../../../src/core/dry-run/dryRunEngine.mjs";

test("SQLite ledger persists config versions, dividends, batches, plans, and idempotency keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "dividend-uploader-"));
  const ledger = new SqliteLedger(join(dir, "ledger.db"));
  ledger.migrate();

  const config = {
    dividendProductMasks: "AAPL*",
    globalCalculation: { globalDividendRatio: 1, roundingDigits: 2, minimumAbsAmount: 0.01 },
    accountScope: { groupMasks: "*", loginMasks: "*" },
    mappings: [
      {
        id: "map-aapl",
        enabled: true,
        platform: "both",
        mtSymbolMask: "AAPL*",
        finnhubSymbol: "AAPL",
        contractSize: 100,
        dividendUnit: "perShare",
        currency: "USD",
        dividendRatio: 1,
        longRatio: 1,
        shortRatio: 1,
        longMultiplier: 1,
        shortMultiplier: -1,
        taxRate: 0,
        priority: 10,
      },
    ],
    reviewPolicy: { mode: "never" },
  };
  const configVersionId = ledger.saveConfigVersion(config, { operator: "tester", reason: "unit test" });
  assert.equal(ledger.getLatestConfigVersion().id, configVersionId);

  const records = [
    {
      id: "manual:AAPL:2026-06-10:0.24",
      source: "manual",
      finnhubSymbol: "AAPL",
      exDate: "2026-06-10",
      dividendUnit: "perShare",
      dividendPerShare: 0.24,
      currency: "USD",
    },
  ];
  ledger.upsertDividendRecords(records, { operator: "tester" });
  assert.equal(ledger.listDividendRecords().length, 1);

  const dryRun = buildDryRun({
    positions: [{ platform: "mt5", login: 10001, group: "real", ticket: 1, symbol: "AAPL.m", side: "buy", volumeLots: 1 }],
    dividendRecords: records,
    config,
  });
  ledger.createBatch({
    id: "batch-unit",
    source: "unit",
    status: dryRun.status,
    configVersionId,
    configSnapshot: config,
    operator: "tester",
    reason: "unit test",
    summary: dryRun.summary,
  });
  ledger.saveAdjustmentPlans("batch-unit", dryRun);
  assert.equal(ledger.listPlans("batch-unit").length, 1);

  ledger.recordExecution({
    plan: { ...ledger.listPlans("batch-unit")[0], batchId: "batch-unit" },
    attempt: 1,
    operator: "tester",
    reason: "unit test",
    result: { success: true, managerReturnCode: 0, managerOperationId: "unit", rawMessage: "ok" },
  });
  assert.equal(ledger.getSuccessfulIdempotencyKeys().size, 1);
  ledger.close();
});
