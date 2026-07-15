import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

function nowIso() {
  return new Date().toISOString();
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function parseJson(value, fallback = null) {
  if (value == null || value === "") {
    return fallback;
  }
  return JSON.parse(value);
}

export class SqliteLedger {
  constructor(databasePath = "runtime/data/dividend-uploader.db") {
    this.databasePath = resolve(databasePath);
    mkdirSync(dirname(this.databasePath), { recursive: true });
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  migrate() {
    const migration = readFileSync(
      new URL("../migrations/001_initial_schema.sql", import.meta.url),
      "utf8",
    );
    this.db.exec(migration);
  }

  close() {
    this.db.close();
  }

  saveConfigVersion(config, { operator = "system", reason = "config update", label = "web" } = {}) {
    const stmt = this.db.prepare(`
      INSERT INTO config_versions (version_label, config_json, created_by, reason, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(label, json(config), operator, reason, nowIso());
    this.audit({
      operator,
      action: "config.version.created",
      targetType: "config_version",
      targetId: String(result.lastInsertRowid),
      reason,
      metadata: { label },
    });
    return Number(result.lastInsertRowid);
  }

  getLatestConfigVersion() {
    const row = this.db
      .prepare("SELECT * FROM config_versions ORDER BY id DESC LIMIT 1")
      .get();
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      versionLabel: row.version_label,
      config: parseJson(row.config_json, {}),
      createdBy: row.created_by,
      reason: row.reason,
      createdAt: row.created_at,
    };
  }

  upsertDividendRecords(records, { operator = "system", reason = "import dividends" } = {}) {
    const stmt = this.db.prepare(`
      INSERT INTO dividend_records (
        id, source, finnhub_symbol, ex_date, dividend_unit, dividend_per_share,
        dividend_per_lot, currency, record_ratio, raw_payload_json, status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source = excluded.source,
        finnhub_symbol = excluded.finnhub_symbol,
        ex_date = excluded.ex_date,
        dividend_unit = excluded.dividend_unit,
        dividend_per_share = excluded.dividend_per_share,
        dividend_per_lot = excluded.dividend_per_lot,
        currency = excluded.currency,
        record_ratio = excluded.record_ratio,
        raw_payload_json = excluded.raw_payload_json,
        status = 'active',
        updated_at = excluded.updated_at
    `);
    const timestamp = nowIso();
    this.db.exec("BEGIN");
    try {
      for (const record of records) {
        stmt.run(
          record.id,
          record.source ?? "manual",
          record.finnhubSymbol ?? record.symbol,
          record.exDate,
          record.dividendUnit ?? "perShare",
          record.dividendPerShare ?? record.amount ?? null,
          record.dividendPerLot ?? record.manualPerLotAmount ?? null,
          record.currency ?? "USD",
          record.dividendRatio ?? record.recordRatio ?? 1,
          json(record.rawPayload ?? record),
          timestamp,
          timestamp,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.audit({
      operator,
      action: "dividend.records.upserted",
      targetType: "dividend_records",
      targetId: "bulk",
      reason,
      metadata: { count: records.length },
    });
    return records.length;
  }

  listDividendRecords({ limit = 500 } = {}) {
    return this.db
      .prepare(`
        SELECT * FROM dividend_records
        WHERE status = 'active'
        ORDER BY ex_date DESC, finnhub_symbol
        LIMIT ?
      `)
      .all(limit)
      .map((row) => ({
        id: row.id,
        source: row.source,
        finnhubSymbol: row.finnhub_symbol,
        exDate: row.ex_date,
        dividendUnit: row.dividend_unit,
        dividendPerShare: row.dividend_per_share,
        dividendPerLot: row.dividend_per_lot,
        currency: row.currency,
        recordRatio: row.record_ratio,
        rawPayload: parseJson(row.raw_payload_json, {}),
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  createBatch({ id, source, status, configVersionId, configSnapshot, operator, reason, summary }) {
    const timestamp = nowIso();
    this.db
      .prepare(`
        INSERT INTO dividend_batches (
          id, source, status, config_version_id, config_snapshot_json, operator,
          reason, dry_run_summary_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        source,
        status,
        configVersionId ?? null,
        json(configSnapshot),
        operator,
        reason ?? "",
        json(summary ?? {}),
        timestamp,
        timestamp,
      );
    this.audit({
      operator,
      action: "batch.created",
      targetType: "dividend_batch",
      targetId: id,
      reason,
      metadata: { status, source },
    });
  }

  saveAdjustmentPlans(batchId, dryRun) {
    const timestamp = nowIso();
    const stmt = this.db.prepare(`
      INSERT INTO adjustment_plans (
        id, batch_id, idempotency_key, platform, login, group_name, ticket, symbol, side,
        lots, ex_date, dividend_id, currency, amount_minor, final_amount, comment,
        matched_product_mask, mapping_rule_id, mapping_snapshot_json, dividend_snapshot_json,
        calculation_snapshot_json, warnings_json, status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        warnings_json = excluded.warnings_json,
        status = 'planned',
        updated_at = excluded.updated_at
    `);
    this.db.exec("BEGIN");
    try {
      for (const plan of dryRun.plans ?? []) {
        stmt.run(
          plan.id,
          batchId,
          plan.idempotencyKey,
          plan.platform,
          String(plan.login),
          plan.group ?? null,
          String(plan.ticket),
          plan.symbol,
          plan.side,
          plan.volumeLots,
          plan.exDate,
          plan.dividendId,
          plan.currency,
          plan.amountMinor,
          plan.finalAmount,
          plan.comment,
          plan.matchedProductMask,
          plan.mappingRuleId,
          json(plan.mappingSnapshot),
          json(plan.dividendSnapshot),
          json(plan.calculation),
          json(plan.warnings),
          timestamp,
          timestamp,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return dryRun.plans?.length ?? 0;
  }

  listBatches({ limit = 100 } = {}) {
    return this.db
      .prepare("SELECT * FROM dividend_batches ORDER BY created_at DESC LIMIT ?")
      .all(limit)
      .map((row) => ({
        id: row.id,
        source: row.source,
        status: row.status,
        configVersionId: row.config_version_id,
        operator: row.operator,
        reason: row.reason,
        summary: parseJson(row.dry_run_summary_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  getBatch(batchId) {
    const row = this.db.prepare("SELECT * FROM dividend_batches WHERE id = ?").get(batchId);
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      source: row.source,
      status: row.status,
      configVersionId: row.config_version_id,
      configSnapshot: parseJson(row.config_snapshot_json, {}),
      operator: row.operator,
      reason: row.reason,
      summary: parseJson(row.dry_run_summary_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listPlans(batchId) {
    return this.db
      .prepare("SELECT * FROM adjustment_plans WHERE batch_id = ? ORDER BY platform, login, ticket, symbol")
      .all(batchId)
      .map((row) => ({
        id: row.id,
        batchId: row.batch_id,
        idempotencyKey: row.idempotency_key,
        platform: row.platform,
        login: row.login,
        group: row.group_name,
        ticket: row.ticket,
        symbol: row.symbol,
        side: row.side,
        volumeLots: row.lots,
        exDate: row.ex_date,
        dividendId: row.dividend_id,
        currency: row.currency,
        amountMinor: row.amount_minor,
        finalAmount: row.final_amount,
        comment: row.comment,
        matchedProductMask: row.matched_product_mask,
        mappingRuleId: row.mapping_rule_id,
        mappingSnapshot: parseJson(row.mapping_snapshot_json, {}),
        dividendSnapshot: parseJson(row.dividend_snapshot_json, {}),
        calculation: parseJson(row.calculation_snapshot_json, {}),
        warnings: parseJson(row.warnings_json, []),
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  getSuccessfulIdempotencyKeys() {
    return new Set(
      this.db
        .prepare("SELECT key FROM idempotency_keys WHERE status = 'success'")
        .all()
        .map((row) => row.key),
    );
  }

  recordExecution({ plan, result, attempt, operator, reason }) {
    const timestamp = nowIso();
    this.db
      .prepare(`
        INSERT INTO adjustment_executions (
          plan_id, idempotency_key, status, attempt, manager_return_code,
          manager_operation_id, raw_message, operator, reason, applied_at, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        plan.id,
        plan.idempotencyKey,
        result.success ? "success" : "failed",
        attempt,
        result.managerReturnCode ?? null,
        result.managerOperationId ?? null,
        result.rawMessage ?? "",
        operator,
        reason ?? "",
        result.success ? timestamp : null,
        timestamp,
      );

    if (result.success) {
      this.db
        .prepare(`
          INSERT INTO idempotency_keys (key, plan_id, status, created_at, applied_at)
          VALUES (?, ?, 'success', ?, ?)
          ON CONFLICT(key) DO UPDATE SET status = 'success', applied_at = excluded.applied_at
        `)
        .run(plan.idempotencyKey, plan.id, timestamp, timestamp);
    }

    this.db
      .prepare("UPDATE adjustment_plans SET status = ?, updated_at = ? WHERE id = ?")
      .run(result.success ? "applied" : "failed", timestamp, plan.id);
  }

  recordMailNotification({ batchId, type, recipients, subject, bodyText, csvText, status, errorMessage = null }) {
    const timestamp = nowIso();
    const result = this.db
      .prepare(`
        INSERT INTO mail_notifications (
          batch_id, type, recipients_json, subject, body_text, csv_text,
          status, error_message, created_at, sent_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        batchId ?? null,
        type,
        json(recipients),
        subject,
        bodyText,
        csvText ?? null,
        status,
        errorMessage,
        timestamp,
        status === "sent" ? timestamp : null,
      );
    return Number(result.lastInsertRowid);
  }

  recordFinnhubSyncEvent(event) {
    this.db
      .prepare(`
        INSERT INTO finnhub_sync_events (
          symbol, from_date, to_date, status, http_status, record_count,
          error_message, raw_payload_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.symbol,
        event.fromDate,
        event.toDate,
        event.status,
        event.httpStatus ?? null,
        event.recordCount ?? 0,
        event.errorMessage ?? null,
        json(event.rawPayload ?? []),
        nowIso(),
      );
  }

  audit({ operator = "system", action, targetType, targetId, reason = "", sourceIp = null, metadata = {} }) {
    this.db
      .prepare(`
        INSERT INTO audit_logs (
          operator, action, target_type, target_id, reason, source_ip, metadata_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(operator, action, targetType, targetId, reason, sourceIp, json(metadata), nowIso());
  }
}
