import { readFileSync } from "node:fs";

export function loadDefaultDividendConfig() {
  const raw = readFileSync(new URL("../../../config/default-dividend-config.template.json", import.meta.url), "utf8");
  return JSON.parse(raw);
}

export function normalizeApplyThrottle(throttle = {}) {
  const warnings = [];
  let intervalSeconds = Number(throttle.intervalSeconds ?? 0.2);

  if (!Number.isFinite(intervalSeconds)) {
    intervalSeconds = 0.2;
    warnings.push("applyThrottle.intervalSeconds was not numeric; defaulted to 0.2");
  }
  if (intervalSeconds < 0.01) {
    intervalSeconds = 0.01;
    warnings.push("applyThrottle.intervalSeconds was below 0.01; clamped to 0.01");
  }
  if (intervalSeconds > 10) {
    intervalSeconds = 10;
    warnings.push("applyThrottle.intervalSeconds was above 10; clamped to 10");
  }

  return {
    intervalSeconds,
    maxRetries: Math.max(0, Number(throttle.maxRetries ?? 3)),
    retryBackoffSeconds: Math.max(0, Number(throttle.retryBackoffSeconds ?? 2)),
    continueOnError: Boolean(throttle.continueOnError),
    allowPauseResume: throttle.allowPauseResume !== false,
    warnings,
  };
}
