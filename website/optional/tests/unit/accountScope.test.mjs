import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAccountScope, evaluateScopeValue } from "../../../src/core/rules/accountScope.mjs";

test("exclude rules override include rules regardless of order", () => {
  const result = evaluateScopeValue("GroupA", "!GroupA,*");
  assert.equal(result.allowed, false);
  assert.equal(result.matchedExclude, "GroupA");
});

test("only exclude rules imply include all", () => {
  assert.equal(evaluateScopeValue("GroupB", "!GroupA").allowed, true);
  assert.equal(evaluateScopeValue("GroupA", "!GroupA").allowed, false);
});

test("account scope requires group and login to be allowed", () => {
  const result = evaluateAccountScope(
    { group: "real\\VIP-1", login: 10001 },
    { groupMasks: "real\\*,!real\\test*", loginMasks: "!10001,*" },
  );
  assert.equal(result.allowed, false);
  assert.equal(result.login.matchedExclude, "10001");
});
