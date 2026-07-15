import { FinnhubDividendClient } from "../../adapters/finnhub/FinnhubDividendClient.mjs";

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

export async function runFinnhubSync({ config, ledger, apiKey = process.env.FINNHUB_API_KEY, now = new Date() }) {
  const syncConfig = config.finnhub?.syncSchedule ?? {};
  const retry = config.finnhub?.retry ?? {};
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - Number(syncConfig.lookbackDays ?? 7));
  const to = new Date(now);
  to.setUTCDate(to.getUTCDate() + Number(syncConfig.lookaheadDays ?? 30));

  const client = new FinnhubDividendClient({ apiKey });
  const symbols = [...new Set((config.mappings ?? []).filter((m) => m.enabled).map((m) => m.finnhubSymbol))];
  const imported = [];
  const events = [];

  for (const symbol of symbols) {
    try {
      const result = await client.fetchDividends({
        symbol,
        fromDate: dateOnly(from),
        toDate: dateOnly(to),
        maxRetries: Number(retry.maxRetries ?? 3),
        backoffSeconds: Number(retry.backoffSeconds ?? 5),
      });
      ledger.recordFinnhubSyncEvent({
        symbol,
        fromDate: result.fromDate,
        toDate: result.toDate,
        status: "success",
        httpStatus: result.httpStatus,
        recordCount: result.records.length,
        rawPayload: result.rawPayload,
      });
      ledger.upsertDividendRecords(result.records, {
        operator: "finnhub-sync",
        reason: `Finnhub sync ${symbol}`,
      });
      imported.push(...result.records);
      events.push({ symbol, status: "success", count: result.records.length });
    } catch (error) {
      ledger.recordFinnhubSyncEvent({
        symbol,
        fromDate: dateOnly(from),
        toDate: dateOnly(to),
        status: "failed",
        httpStatus: error.httpStatus,
        errorMessage: error.message,
        rawPayload: error.payload ?? [],
      });
      events.push({ symbol, status: "failed", error: error.message });
    }
  }

  return { imported, events };
}
