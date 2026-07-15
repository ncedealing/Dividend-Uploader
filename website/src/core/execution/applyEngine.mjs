import { setTimeout as delay } from "node:timers/promises";
import { normalizeApplyThrottle } from "../domain/defaultConfig.mjs";

function stablePlanSort(a, b) {
  return (
    String(a.platform).localeCompare(String(b.platform)) ||
    String(a.login).localeCompare(String(b.login), undefined, { numeric: true }) ||
    String(a.ticket).localeCompare(String(b.ticket), undefined, { numeric: true }) ||
    String(a.symbol).localeCompare(String(b.symbol))
  );
}

export async function applyAdjustmentPlans({
  plans,
  managerApi,
  ledger,
  throttle,
  operator = "system",
  reason = "",
  sleep = delay,
} = {}) {
  const normalizedThrottle = normalizeApplyThrottle(throttle);
  const results = [];

  for (const plan of [...plans].sort(stablePlanSort)) {
    let lastResult = null;
    for (let attempt = 1; attempt <= normalizedThrottle.maxRetries + 1; attempt += 1) {
      const request = {
        platform: plan.platform,
        login: plan.login,
        amountMinor: plan.amountMinor,
        currency: plan.currency,
        comment: plan.comment,
        idempotencyKey: plan.idempotencyKey,
        batchId: plan.batchId,
        adjustmentId: plan.id,
      };
      lastResult = await managerApi.applyBalanceAdjustment(request);
      ledger?.recordExecution?.({ plan, result: lastResult, attempt, operator, reason });
      if (lastResult.success) {
        break;
      }
      if (attempt <= normalizedThrottle.maxRetries) {
        await sleep(normalizedThrottle.retryBackoffSeconds * 1000);
      }
    }

    results.push({ planId: plan.id, idempotencyKey: plan.idempotencyKey, result: lastResult });
    if (!lastResult?.success && !normalizedThrottle.continueOnError) {
      break;
    }

    await sleep(normalizedThrottle.intervalSeconds * 1000);
  }

  return {
    throttle: normalizedThrottle,
    results,
    successCount: results.filter((item) => item.result?.success).length,
    failureCount: results.filter((item) => !item.result?.success).length,
  };
}
