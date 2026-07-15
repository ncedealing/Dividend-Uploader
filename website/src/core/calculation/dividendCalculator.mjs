function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function roundToDigits(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

export function toMinorUnits(value, digits = 2) {
  return Math.round(roundToDigits(value, digits) * 10 ** digits);
}

export function calculateDividendAdjustment({ position, dividend, mapping, config }) {
  const globalCalculation = config?.globalCalculation ?? {};
  const side = String(position.side ?? "").toLowerCase() === "sell" ? "sell" : "buy";
  const dividendUnit =
    dividend.dividendUnit ?? dividend.unit ?? mapping.dividendUnit ?? globalCalculation.defaultDividendUnit ?? "perShare";
  const contractSize = numberOrDefault(mapping.contractSize, 1);
  const dividendPerShare = numberOrDefault(
    dividend.dividendPerShare ?? dividend.amount ?? dividend.cashAmount,
    0,
  );
  const manualPerLotAmount = numberOrDefault(
    dividend.dividendPerLot ?? dividend.manualPerLotAmount ?? dividend.perLotAmount,
    0,
  );
  const basePerLot = dividendUnit === "perLot" ? manualPerLotAmount : dividendPerShare * contractSize;

  const globalRatio = numberOrDefault(globalCalculation.globalDividendRatio, 1);
  const mappingRatio = numberOrDefault(mapping.dividendRatio, 1);
  const recordRatio = numberOrDefault(dividend.dividendRatio ?? dividend.recordRatio, 1);
  const sideRatio = side === "buy" ? numberOrDefault(mapping.longRatio, 1) : numberOrDefault(mapping.shortRatio, 1);
  const directionMultiplier =
    side === "buy"
      ? numberOrDefault(mapping.longMultiplier ?? globalCalculation.defaultLongMultiplier, 1)
      : numberOrDefault(mapping.shortMultiplier ?? globalCalculation.defaultShortMultiplier, -1);
  const taxRate = numberOrDefault(mapping.taxRate ?? globalCalculation.defaultTaxRate, 0);
  const roundingDigits = numberOrDefault(globalCalculation.roundingDigits, 2);

  const adjustedPerLot = basePerLot * globalRatio * mappingRatio * recordRatio * sideRatio;
  const grossAmount = numberOrDefault(position.volumeLots ?? position.lots, 0) * adjustedPerLot * directionMultiplier;
  const finalAmount = grossAmount * (1 - taxRate);
  const roundedAmount = roundToDigits(finalAmount, roundingDigits);
  const amountMinor = toMinorUnits(finalAmount, roundingDigits);
  const currency = mapping.currency ?? dividend.currency ?? globalCalculation.defaultCurrency ?? "USD";

  const warnings = [];
  const minimumAbsAmount = numberOrDefault(globalCalculation.minimumAbsAmount, 0);
  if (Math.abs(roundedAmount) < minimumAbsAmount) {
    warnings.push({
      code: "below_minimum_abs_amount",
      severity: "warning",
      message: `Absolute amount ${Math.abs(roundedAmount)} is below minimum ${minimumAbsAmount}`,
    });
  }
  if (dividend.currency && mapping.currency && dividend.currency !== mapping.currency) {
    warnings.push({
      code: "currency_mismatch",
      severity: "error",
      message: `Dividend currency ${dividend.currency} differs from mapping currency ${mapping.currency}`,
    });
  }

  const comment = [
    `DIV ${position.symbol}`,
    `ticket=${position.ticket}`,
    `side=${side.toUpperCase()}`,
    `lots=${numberOrDefault(position.volumeLots ?? position.lots, 0)}`,
    `perLot=${roundToDigits(adjustedPerLot, roundingDigits)}`,
    `exDate=${dividend.exDate}`,
    `source=${dividend.source ?? "manual"}`,
  ].join(" ");

  return {
    dividendUnit,
    dividendPerShare,
    originalPerLot: dividendUnit === "perLot" ? manualPerLotAmount : dividendPerShare * contractSize,
    adjustedPerLot: roundToDigits(adjustedPerLot, roundingDigits),
    ratios: {
      globalRatio,
      mappingRatio,
      recordRatio,
      sideRatio,
    },
    taxRate,
    directionMultiplier,
    grossAmount: roundToDigits(grossAmount, roundingDigits),
    finalAmount: roundedAmount,
    amountMinor,
    currency,
    comment,
    warnings,
  };
}
