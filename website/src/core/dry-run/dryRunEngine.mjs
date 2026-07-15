import { calculateDividendAdjustment } from "../calculation/dividendCalculator.mjs";
import { createIdempotencyKey } from "../idempotency/idempotencyKey.mjs";
import { evaluateAccountScope } from "../rules/accountScope.mjs";
import { findMatchedMask } from "../rules/patterns.mjs";
import { matchMapping } from "../rules/mappingMatcher.mjs";
import { evaluateReviewPolicy } from "../review/reviewPolicy.mjs";

function stablePositionSort(a, b) {
  return (
    String(a.platform).localeCompare(String(b.platform)) ||
    Number(a.login) - Number(b.login) ||
    Number(a.ticket) - Number(b.ticket) ||
    String(a.symbol).localeCompare(String(b.symbol))
  );
}

function stableRecordSort(a, b) {
  return (
    recordSymbol(a).localeCompare(recordSymbol(b)) ||
    String(a.exDate).localeCompare(String(b.exDate)) ||
    String(a.id).localeCompare(String(b.id))
  );
}

function recordSymbol(record = {}) {
  return String(record.productSymbol ?? record.displaySymbol ?? record.symbol ?? record.finnhubSymbol ?? "").toUpperCase();
}

function mappingSymbol(mapping = {}) {
  return String(mapping.productSymbol ?? mapping.displaySymbol ?? mapping.symbol ?? mapping.finnhubSymbol ?? "").toUpperCase();
}

function summarize(plans, warnings) {
  const accounts = new Map();
  const products = new Set();
  let buyTotal = 0;
  let sellTotal = 0;
  let maxSingleOrderAbsAmount = 0;

  for (const plan of plans) {
    const amount = plan.finalAmount;
    if (plan.side === "buy") {
      buyTotal += amount;
    } else {
      sellTotal += amount;
    }
    products.add(plan.symbol);
    accounts.set(plan.login, (accounts.get(plan.login) ?? 0) + amount);
    maxSingleOrderAbsAmount = Math.max(maxSingleOrderAbsAmount, Math.abs(amount));
  }

  const maxSingleAccountAbsAmount = Math.max(0, ...[...accounts.values()].map((amount) => Math.abs(amount)));
  const totalAmount = plans.reduce((sum, plan) => sum + plan.finalAmount, 0);

  return {
    orderCount: plans.length,
    accountCount: accounts.size,
    productCount: products.size,
    totalAmount: Math.round(totalAmount * 100) / 100,
    buyTotal: Math.round(buyTotal * 100) / 100,
    sellTotal: Math.round(sellTotal * 100) / 100,
    maxSingleOrderAbsAmount,
    maxSingleAccountAbsAmount,
    warningCount: warnings.length,
    errorCount: warnings.filter((warning) => warning.severity === "error").length,
  };
}

export function buildDryRun({ positions = [], dividendRecords = [], config, existingIdempotencyKeys = new Set() }) {
  const plans = [];
  const skipped = [];
  const warnings = [];
  const dividendsBySymbol = new Map();
  const productMasks = config.dividendProductMasks ?? "";

  for (const record of [...dividendRecords].sort(stableRecordSort)) {
    const key = recordSymbol(record);
    if (!dividendsBySymbol.has(key)) {
      dividendsBySymbol.set(key, []);
    }
    dividendsBySymbol.get(key).push(record);
  }

  for (const position of [...positions].sort(stablePositionSort)) {
    const normalizedPosition = {
      ...position,
      platform: String(position.platform ?? "").toLowerCase(),
      side: String(position.side ?? "").toLowerCase() === "sell" ? "sell" : "buy",
    };
    const matchedProductMask = findMatchedMask(normalizedPosition.symbol, productMasks);

    if (!matchedProductMask) {
      skipped.push({
        platform: normalizedPosition.platform,
        login: normalizedPosition.login,
        ticket: normalizedPosition.ticket,
        symbol: normalizedPosition.symbol,
        reason: "product_out_of_scope",
      });
      continue;
    }

    const globalScope = evaluateAccountScope(normalizedPosition, config.accountScope ?? {});
    if (!globalScope.allowed) {
      skipped.push({
        platform: normalizedPosition.platform,
        login: normalizedPosition.login,
        ticket: normalizedPosition.ticket,
        symbol: normalizedPosition.symbol,
        matchedProductMask,
        reason: "account_out_of_scope",
        accountScope: globalScope,
      });
      continue;
    }

    const mappingMatch = matchMapping(normalizedPosition, config.mappings ?? []);
    if (mappingMatch.status !== "matched") {
      const code = mappingMatch.status === "conflict" ? "mapping_conflict" : "missing_mapping";
      warnings.push({
        code,
        severity: "error",
        platform: normalizedPosition.platform,
        login: normalizedPosition.login,
        ticket: normalizedPosition.ticket,
        symbol: normalizedPosition.symbol,
        matchedProductMask,
        message: mappingMatch.message,
        conflictMappingIds: mappingMatch.conflictCandidates.map((mapping) => mapping.id),
      });
      continue;
    }

    const mapping = mappingMatch.mapping;
    const symbolRecords = dividendsBySymbol.get(mappingSymbol(mapping)) ?? [];
    if (symbolRecords.length === 0) {
      skipped.push({
        platform: normalizedPosition.platform,
        login: normalizedPosition.login,
        ticket: normalizedPosition.ticket,
        symbol: normalizedPosition.symbol,
        matchedProductMask,
        mappingId: mapping.id,
        reason: "no_dividend_record",
      });
      continue;
    }

    for (const dividend of symbolRecords) {
      const calculation = calculateDividendAdjustment({
        position: normalizedPosition,
        dividend,
        mapping,
        config,
      });
      const planBase = {
        platform: normalizedPosition.platform,
        login: normalizedPosition.login,
        group: normalizedPosition.group,
        ticket: normalizedPosition.ticket,
        symbol: normalizedPosition.symbol,
        side: normalizedPosition.side,
        volumeLots: Number(normalizedPosition.volumeLots ?? normalizedPosition.lots ?? 0),
        exDate: dividend.exDate,
        dividendId: dividend.id,
        amountMinor: calculation.amountMinor,
      };
      const idempotencyKey = createIdempotencyKey(planBase);
      const planWarnings = [...calculation.warnings];

      if (existingIdempotencyKeys.has(idempotencyKey)) {
        planWarnings.push({
          code: "duplicate_idempotency_key",
          severity: "error",
          message: "This adjustment has already been successfully applied",
        });
      }

      const plan = {
        id: idempotencyKey,
        ...planBase,
        matchedProductMask,
        mappingRuleId: mapping.id,
        mappingSnapshot: structuredClone(mapping),
        productSymbol: mappingSymbol(mapping),
        finnhubSymbol: mapping.finnhubSymbol,
        dividendSnapshot: structuredClone(dividend),
        calculation,
        currency: calculation.currency,
        originalPerShare: calculation.dividendPerShare,
        originalPerLot: calculation.originalPerLot,
        adjustedPerLot: calculation.adjustedPerLot,
        taxRate: calculation.taxRate,
        finalAmount: calculation.finalAmount,
        comment: calculation.comment,
        idempotencyKey,
        warnings: planWarnings,
      };

      for (const warning of planWarnings) {
        warnings.push({
          ...warning,
          platform: plan.platform,
          login: plan.login,
          ticket: plan.ticket,
          symbol: plan.symbol,
          mappingRuleId: plan.mappingRuleId,
          idempotencyKey,
        });
      }

      plans.push(plan);
    }
  }

  const summary = summarize(plans, warnings);
  const review = evaluateReviewPolicy({ plans, skipped, warnings, summary }, config.reviewPolicy ?? {});

  return {
    status: review.status,
    generatedAt: new Date().toISOString(),
    plans,
    skipped,
    warnings,
    summary,
    review,
  };
}
