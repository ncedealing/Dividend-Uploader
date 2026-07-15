const BLOCKING_WARNING_CODES = new Set([
  "missing_mapping",
  "mapping_conflict",
  "currency_mismatch",
  "duplicate_idempotency_key",
]);

function exceeds(value, threshold) {
  return Number.isFinite(Number(threshold)) && Number(value) > Number(threshold);
}

export function evaluateReviewPolicy(dryRun, reviewPolicy = {}) {
  const mode = reviewPolicy.mode ?? "threshold";
  const thresholds = reviewPolicy.thresholds ?? {};
  const warnings = dryRun.warnings ?? [];
  const blockingWarnings = warnings.filter((warning) => BLOCKING_WARNING_CODES.has(warning.code));

  if (blockingWarnings.length > 0) {
    return {
      status: "blocked",
      reviewRequired: true,
      autoApplyAllowed: false,
      reasons: blockingWarnings.map((warning) => warning.code),
      blockingWarnings,
    };
  }

  if (mode === "always") {
    return {
      status: "pending_review",
      reviewRequired: true,
      autoApplyAllowed: false,
      reasons: ["policy_always"],
      blockingWarnings: [],
    };
  }

  if (mode === "never") {
    return {
      status: "ready",
      reviewRequired: false,
      autoApplyAllowed: true,
      reasons: [],
      blockingWarnings: [],
    };
  }

  const reasons = [];
  const summary = dryRun.summary ?? {};
  if (exceeds(Math.abs(summary.totalAmount ?? 0), thresholds.totalAbsAmount)) {
    reasons.push("total_abs_amount");
  }
  if (exceeds(summary.maxSingleOrderAbsAmount ?? 0, thresholds.singleOrderAbsAmount)) {
    reasons.push("single_order_abs_amount");
  }
  if (exceeds(summary.maxSingleAccountAbsAmount ?? 0, thresholds.singleAccountAbsAmount)) {
    reasons.push("single_account_abs_amount");
  }
  if (exceeds(summary.orderCount ?? 0, thresholds.orderCount)) {
    reasons.push("order_count");
  }
  if (exceeds(summary.accountCount ?? 0, thresholds.accountCount)) {
    reasons.push("account_count");
  }
  if (exceeds(summary.productCount ?? 0, thresholds.productCount)) {
    reasons.push("product_count");
  }
  if (thresholds.hasWarnings && warnings.length > 0) {
    reasons.push("has_warnings");
  }

  return {
    status: reasons.length > 0 ? "pending_review" : "ready",
    reviewRequired: reasons.length > 0,
    autoApplyAllowed: reasons.length === 0,
    reasons,
    blockingWarnings: [],
  };
}
