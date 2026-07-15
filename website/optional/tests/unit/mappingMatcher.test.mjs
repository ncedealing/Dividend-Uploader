import test from "node:test";
import assert from "node:assert/strict";
import { matchMapping } from "../../../src/core/rules/mappingMatcher.mjs";

const subject = {
  platform: "mt5",
  symbol: "AAPL.m",
  login: 10001,
  group: "real\\VIP",
};

test("exact MT symbol mapping wins over wildcard mapping", () => {
  const result = matchMapping(subject, [
    { id: "wild", enabled: true, platform: "both", mtSymbolMask: "AAPL*", finnhubSymbol: "AAPL", priority: 1 },
    { id: "exact", enabled: true, platform: "mt5", mtSymbolMask: "AAPL.m", finnhubSymbol: "AAPL", priority: 99 },
  ]);
  assert.equal(result.status, "matched");
  assert.equal(result.mapping.id, "exact");
});

test("lower priority wins among same specificity rules", () => {
  const result = matchMapping(subject, [
    { id: "later", enabled: true, platform: "both", mtSymbolMask: "AAPL*", finnhubSymbol: "AAPL", priority: 20 },
    { id: "first", enabled: true, platform: "both", mtSymbolMask: "AAPL*", finnhubSymbol: "AAPL", priority: 10 },
  ]);
  assert.equal(result.mapping.id, "first");
});

test("conflicting top-ranked mappings block dry-run application", () => {
  const result = matchMapping(subject, [
    { id: "a", enabled: true, platform: "both", mtSymbolMask: "AAPL*", finnhubSymbol: "AAPL", priority: 10 },
    { id: "b", enabled: true, platform: "both", mtSymbolMask: "AAPL*", finnhubSymbol: "APPLX", priority: 10 },
  ]);
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.conflictCandidates.map((mapping) => mapping.id), ["a", "b"]);
});
