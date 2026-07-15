import test from "node:test";
import assert from "node:assert/strict";
import { findMatchedMask, matchesPattern, splitRuleList } from "../../../src/core/rules/patterns.mjs";

test("splitRuleList accepts comma, Chinese comma, semicolon, and newlines", () => {
  assert.deepEqual(splitRuleList("AAPL.m， TSLA.m; Indices*\nIndex*"), [
    "AAPL.m",
    "TSLA.m",
    "Indices*",
    "Index*",
  ]);
});

test("wildcard masks support star and question mark", () => {
  assert.equal(matchesPattern("Stocks.US.AAPL", "Stocks.US.*"), true);
  assert.equal(matchesPattern("AAPL.m", "AAPL.?"), true);
  assert.equal(matchesPattern("AAPL.micro", "AAPL.?"), false);
});

test("findMatchedMask returns the first matching product range rule", () => {
  assert.equal(findMatchedMask("AAPL.m", "TSLA.m, AAPL.*"), "AAPL.*");
  assert.equal(findMatchedMask("EURUSD", "AAPL.*, TSLA.*"), null);
});
