import test from "node:test";
import assert from "node:assert/strict";
import { calculateDividendAdjustment } from "../../../src/core/calculation/dividendCalculator.mjs";
import { buildDryRun } from "../../../src/core/dry-run/dryRunEngine.mjs";

const config = {
  dividendProductMasks: "AAPL.m, TSLA.m",
  globalCalculation: {
    globalDividendRatio: 1,
    defaultDividendUnit: "perShare",
    defaultLongMultiplier: 1,
    defaultShortMultiplier: -1,
    defaultTaxRate: 0,
    minimumAbsAmount: 0.01,
    roundingDigits: 2,
  },
  accountScope: { enabled: true, groupMasks: "*", loginMasks: "*" },
  mappings: [
    {
      id: "map-aapl",
      enabled: true,
      platform: "both",
      mtSymbolMask: "AAPL.m",
      finnhubSymbol: "AAPL",
      contractSize: 100,
      dividendUnit: "perShare",
      currency: "USD",
      dividendRatio: 1,
      longRatio: 1,
      shortRatio: 1,
      longMultiplier: 1,
      shortMultiplier: -1,
      taxRate: 0.1,
      priority: 10,
      accountScope: { groupMasks: "*", loginMasks: "*" },
    },
  ],
  reviewPolicy: { mode: "threshold", thresholds: { singleOrderAbsAmount: 1000 } },
};

const dividend = {
  id: "manual:AAPL:2026-06-10:0.24",
  source: "manual",
  finnhubSymbol: "AAPL",
  exDate: "2026-06-10",
  dividendUnit: "perShare",
  dividendPerShare: 0.24,
  currency: "USD",
  recordRatio: 1,
};

test("per-share dividends convert to per-lot and apply side multiplier and tax", () => {
  const buy = calculateDividendAdjustment({
    position: { side: "buy", volumeLots: 1.2, symbol: "AAPL.m", ticket: 1 },
    dividend,
    mapping: config.mappings[0],
    config,
  });
  assert.equal(buy.originalPerLot, 24);
  assert.equal(buy.adjustedPerLot, 24);
  assert.equal(buy.finalAmount, 25.92);

  const sell = calculateDividendAdjustment({
    position: { side: "sell", volumeLots: 0.5, symbol: "AAPL.m", ticket: 2 },
    dividend,
    mapping: config.mappings[0],
    config,
  });
  assert.equal(sell.finalAmount, -10.8);
});

test("dry-run includes matched product mask, mapping snapshot, and duplicate idempotency warning", () => {
  const first = buildDryRun({
    positions: [
      { platform: "mt5", login: 10001, group: "real", ticket: 1, symbol: "AAPL.m", side: "buy", volumeLots: 1 },
    ],
    dividendRecords: [dividend],
    config,
  });
  assert.equal(first.status, "ready");
  assert.equal(first.plans[0].matchedProductMask, "AAPL.m");
  assert.equal(first.plans[0].mappingRuleId, "map-aapl");

  const second = buildDryRun({
    positions: [
      { platform: "mt5", login: 10001, group: "real", ticket: 1, symbol: "AAPL.m", side: "buy", volumeLots: 1 },
    ],
    dividendRecords: [dividend],
    config,
    existingIdempotencyKeys: new Set([first.plans[0].idempotencyKey]),
  });
  assert.equal(second.status, "blocked");
  assert.equal(second.warnings.some((warning) => warning.code === "duplicate_idempotency_key"), true);
});

test("dry-run blocks mapping conflicts", () => {
  const conflict = structuredClone(config);
  conflict.mappings.push({ ...conflict.mappings[0], id: "map-aapl-2" });
  const result = buildDryRun({
    positions: [
      { platform: "mt5", login: 10001, group: "real", ticket: 1, symbol: "AAPL.m", side: "buy", volumeLots: 1 },
    ],
    dividendRecords: [dividend],
    config: conflict,
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.warnings[0].code, "mapping_conflict");
});
