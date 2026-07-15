function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/u.test(text)) {
    return `"${text.replace(/"/gu, '""')}"`;
  }
  return text;
}

export function buildAuditCsv(dryRun) {
  const header = [
    "platform",
    "login",
    "ticket",
    "symbol",
    "side",
    "lots",
    "matchedProductMask",
    "mappingRuleId",
    "exDate",
    "originalPerShare",
    "originalPerLot",
    "adjustedPerLot",
    "taxRate",
    "currency",
    "finalAmount",
    "idempotencyKey",
    "warnings",
  ];
  const rows = (dryRun.plans ?? []).map((plan) => [
    plan.platform,
    plan.login,
    plan.ticket,
    plan.symbol,
    plan.side,
    plan.volumeLots,
    plan.matchedProductMask,
    plan.mappingRuleId,
    plan.exDate,
    plan.originalPerShare,
    plan.originalPerLot,
    plan.adjustedPerLot,
    plan.taxRate,
    plan.currency,
    plan.finalAmount,
    plan.idempotencyKey,
    (plan.warnings ?? []).map((warning) => warning.code).join(";"),
  ]);
  return [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
}

export function composeAuditEmail({ dryRun, batchId, previewUrl, source = "dry-run", recipients = [] }) {
  const summary = dryRun.summary ?? {};
  const productSummary = new Map();
  for (const plan of dryRun.plans ?? []) {
    const existing = productSummary.get(plan.symbol) ?? {
      symbol: plan.symbol,
      orders: 0,
      amount: 0,
      buyAmount: 0,
      sellAmount: 0,
      warnings: 0,
    };
    existing.orders += 1;
    existing.amount += plan.finalAmount;
    if (plan.side === "buy") {
      existing.buyAmount += plan.finalAmount;
    } else {
      existing.sellAmount += plan.finalAmount;
    }
    existing.warnings += plan.warnings?.length ?? 0;
    productSummary.set(plan.symbol, existing);
  }

  const lines = [
    `Dividend audit preview for batch ${batchId}`,
    "",
    `Source: ${source}`,
    `Platforms: ${[...new Set((dryRun.plans ?? []).map((plan) => plan.platform))].join(", ") || "none"}`,
    `Products: ${summary.productCount ?? 0}`,
    `Accounts: ${summary.accountCount ?? 0}`,
    `Orders: ${summary.orderCount ?? 0}`,
    `Total adjustment: ${summary.totalAmount ?? 0}`,
    `BUY total: ${summary.buyTotal ?? 0}`,
    `SELL total: ${summary.sellTotal ?? 0}`,
    `Warnings: ${summary.warningCount ?? 0}`,
    `Errors: ${summary.errorCount ?? 0}`,
    previewUrl ? `Preview: ${previewUrl}` : null,
    "",
    "Product summary:",
    ...[...productSummary.values()].map(
      (item) =>
        `- ${item.symbol}: orders=${item.orders}, total=${item.amount.toFixed(2)}, buy=${item.buyAmount.toFixed(
          2,
        )}, sell=${item.sellAmount.toFixed(2)}, warnings=${item.warnings}`,
    ),
  ].filter(Boolean);

  return {
    recipients,
    subject: `[Dividend Uploader] Audit preview ${batchId}`,
    bodyText: lines.join("\n"),
    csvText: buildAuditCsv(dryRun),
  };
}
