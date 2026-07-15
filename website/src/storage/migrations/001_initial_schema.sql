PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS config_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_label TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dividend_records (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  finnhub_symbol TEXT NOT NULL,
  ex_date TEXT NOT NULL,
  dividend_unit TEXT NOT NULL,
  dividend_per_share REAL,
  dividend_per_lot REAL,
  currency TEXT NOT NULL,
  record_ratio REAL NOT NULL DEFAULT 1,
  raw_payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dividend_records_symbol_date
  ON dividend_records (finnhub_symbol, ex_date);

CREATE TABLE IF NOT EXISTS dividend_batches (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  config_version_id INTEGER,
  config_snapshot_json TEXT NOT NULL,
  operator TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  dry_run_summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (config_version_id) REFERENCES config_versions(id)
);

CREATE TABLE IF NOT EXISTS adjustment_plans (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  login TEXT NOT NULL,
  group_name TEXT,
  ticket TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  lots REAL NOT NULL,
  ex_date TEXT NOT NULL,
  dividend_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  final_amount REAL NOT NULL,
  comment TEXT NOT NULL,
  matched_product_mask TEXT NOT NULL,
  mapping_rule_id TEXT NOT NULL,
  mapping_snapshot_json TEXT NOT NULL,
  dividend_snapshot_json TEXT NOT NULL,
  calculation_snapshot_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'planned',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES dividend_batches(id)
);

CREATE INDEX IF NOT EXISTS idx_adjustment_plans_batch
  ON adjustment_plans (batch_id, platform, login, ticket, symbol);

CREATE TABLE IF NOT EXISTS adjustment_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  manager_return_code INTEGER,
  manager_operation_id TEXT,
  raw_message TEXT NOT NULL DEFAULT '',
  operator TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  applied_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (plan_id) REFERENCES adjustment_plans(id)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  applied_at TEXT,
  FOREIGN KEY (plan_id) REFERENCES adjustment_plans(id)
);

CREATE TABLE IF NOT EXISTS mail_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT,
  type TEXT NOT NULL,
  recipients_json TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  csv_text TEXT,
  status TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  FOREIGN KEY (batch_id) REFERENCES dividend_batches(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operator TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  source_ip TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS manager_api_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  return_code INTEGER,
  message TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS finnhub_sync_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  record_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  raw_payload_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_locks (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
