import { createHash } from "node:crypto";

export function createIdempotencyMaterial(plan) {
  return [
    String(plan.platform ?? "").toLowerCase(),
    String(plan.login ?? ""),
    String(plan.ticket ?? ""),
    String(plan.symbol ?? ""),
    String(plan.exDate ?? ""),
    String(plan.dividendId ?? ""),
    String(plan.amountMinor ?? ""),
  ].join("|");
}

export function createIdempotencyKey(plan) {
  const material = createIdempotencyMaterial(plan);
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 16);
  return `${String(plan.platform ?? "").toLowerCase()}:${plan.login}:${plan.ticket}:${plan.symbol}:${plan.exDate}:${plan.dividendId}:${plan.amountMinor}:${digest}`;
}
