import { SqliteLedger } from "../../storage/repositories/SqliteLedger.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEBSITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_DB_PATH = resolve(WEBSITE_ROOT, "runtime/data/dividend-uploader.db");

export function createLedger(databasePath = process.env.DIVIDEND_UPLOADER_DB ?? DEFAULT_DB_PATH) {
  const ledger = new SqliteLedger(databasePath);
  ledger.migrate();
  return ledger;
}
