import type { Pool } from "pg";

export interface AlertControlPlaneMetrics {
  activeRules: number;
  dueRules: number;
  leasedRules: number;
  archivedRules: number;
  rulesWithErrors: number;
  oldestDueAgeMs: number;
  evaluationsLastMinute: number;
  triggersLastMinute: number;
}

interface AlertMetricsRow {
  active_rules: string;
  due_rules: string;
  leased_rules: string;
  archived_rules: string;
  rules_with_errors: string;
  oldest_due_age_ms: string;
  evaluations_last_minute: string;
  triggers_last_minute: string;
}

/** A single bounded snapshot used only for structured worker diagnostics. */
export class AlertOperabilityRepository {
  constructor(private readonly pool: Pool) {}

  async getMetrics(): Promise<AlertControlPlaneMetrics> {
    const result = await this.pool.query<AlertMetricsRow>(`
      SELECT
        (SELECT count(*)::text
         FROM alert_rules
         WHERE status = 'active') AS active_rules,
        (SELECT count(*)::text
         FROM alert_rules
         WHERE status = 'active'
           AND lease_owner IS NULL
           AND next_evaluation_at <= clock_timestamp()) AS due_rules,
        (SELECT count(*)::text
         FROM alert_rules
         WHERE lease_owner IS NOT NULL) AS leased_rules,
        (SELECT count(*)::text
         FROM alert_rules
         WHERE status = 'archived') AS archived_rules,
        (SELECT count(*)::text
         FROM alert_rules
         WHERE status = 'active' AND last_error_code IS NOT NULL) AS rules_with_errors,
        COALESCE((
          SELECT GREATEST(
            0,
            floor(extract(epoch FROM (clock_timestamp() - min(next_evaluation_at))) * 1000)
          )::bigint::text
          FROM alert_rules
          WHERE status = 'active'
            AND lease_owner IS NULL
            AND next_evaluation_at <= clock_timestamp()
        ), '0') AS oldest_due_age_ms,
        (SELECT count(*)::text
         FROM alert_evaluation_receipts
         WHERE created_at >= clock_timestamp() - interval '1 minute') AS evaluations_last_minute,
        (SELECT count(*)::text
         FROM alert_rule_events
         WHERE event_type = 'triggered'
           AND created_at >= clock_timestamp() - interval '1 minute') AS triggers_last_minute
    `);
    const row = result.rows[0];
    if (!row) throw new Error("Alert operability metrics query returned no row.");
    return {
      activeRules: count(row.active_rules, "active alert rules"),
      dueRules: count(row.due_rules, "due alert rules"),
      leasedRules: count(row.leased_rules, "leased alert rules"),
      archivedRules: count(row.archived_rules, "archived alert rules"),
      rulesWithErrors: count(row.rules_with_errors, "alert rules with errors"),
      oldestDueAgeMs: count(row.oldest_due_age_ms, "oldest due alert age"),
      evaluationsLastMinute: count(row.evaluations_last_minute, "recent alert evaluations"),
      triggersLastMinute: count(row.triggers_last_minute, "recent alert triggers")
    };
  }
}

function count(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${label} metric is invalid.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} metric exceeds the safe integer range.`);
  }
  return parsed;
}
