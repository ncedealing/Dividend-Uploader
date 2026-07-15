import { setTimeout as delay } from "node:timers/promises";

function maskToken(token) {
  if (!token) {
    return "";
  }
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function normalizeFinnhubDividend(row, symbol) {
  const exDate = row.exDate ?? row.date;
  const amount = Number(row.amount ?? row.dividend ?? 0);
  return {
    id: `finnhub:${symbol}:${exDate}:${amount}`,
    source: "finnhub",
    finnhubSymbol: symbol,
    exDate,
    dividendUnit: "perShare",
    dividendPerShare: amount,
    currency: row.currency ?? "USD",
    recordRatio: 1,
    rawPayload: row,
  };
}

export class FinnhubDividendClient {
  constructor({ apiKey, fetchImpl = globalThis.fetch, baseUrl = "https://finnhub.io/api/v1" } = {}) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl;
  }

  async fetchDividends({ symbol, fromDate, toDate, maxRetries = 3, backoffSeconds = 5 } = {}) {
    if (!this.apiKey) {
      throw new Error("FINNHUB_API_KEY is not configured");
    }
    if (!symbol || !fromDate || !toDate) {
      throw new Error("symbol, fromDate and toDate are required");
    }

    const url = new URL(`${this.baseUrl}/stock/dividend`);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("from", fromDate);
    url.searchParams.set("to", toDate);
    url.searchParams.set("token", this.apiKey);

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await this.fetchImpl(url);
        const text = await response.text();
        let payload;
        try {
          payload = text ? JSON.parse(text) : [];
        } catch {
          payload = text;
        }

        if (response.status === 429 && attempt < maxRetries) {
          await delay(backoffSeconds * 1000 * (attempt + 1));
          continue;
        }
        if (!response.ok) {
          const error = new Error(`Finnhub dividend request failed with HTTP ${response.status}`);
          error.httpStatus = response.status;
          error.payload = payload;
          throw error;
        }

        const records = Array.isArray(payload)
          ? payload.map((row) => normalizeFinnhubDividend(row, symbol))
          : [];

        return {
          symbol,
          fromDate,
          toDate,
          httpStatus: response.status,
          records,
          rawPayload: payload,
          token: maskToken(this.apiKey),
        };
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) {
          await delay(backoffSeconds * 1000 * (attempt + 1));
        }
      }
    }

    throw lastError;
  }
}
