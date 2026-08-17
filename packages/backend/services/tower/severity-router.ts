/**
 * Severity Router — translate legacy report_policy into the 4-tier severity
 * model, and decide what should happen at each tier.
 *
 * Owns: TowerSeverity normalization + report_policy mapping.
 * Public API: normalizeSeverity, severityFromReportPolicy, routeSeverity.
 * See: services/tower/README.md
 *
 * Decision: workspace/decisions/2026-05-04-tower-channel-and-persona.md
 *
 * Phase 2 scope: this module is the *single source of truth* for "given a
 * trigger and a result, what does Tower do?". Callers in unified-scheduler
 * and task-runner consult this — they should not re-derive routing locally.
 */

export type TowerSeverity = 'L1' | 'L2' | 'L3' | 'L4';

// ── Validation / normalization ───────────────────────────────────────

const VALID_SEVERITIES = new Set<TowerSeverity>(['L1', 'L2', 'L3', 'L4']);

/**
 * Coerce an unknown value to a valid TowerSeverity.
 * Anything not in the set falls back to 'L2' (digest — the safe default).
 */
export function normalizeSeverity(value: unknown): TowerSeverity {
  if (typeof value === 'string' && VALID_SEVERITIES.has(value as TowerSeverity)) {
    return value as TowerSeverity;
  }
  return 'L2';
}

// ── report_policy → severity bridge ─────────────────────────────────

/**
 * Task `report_policy` → severity.
 *
 * Current writes use `silent` or `notification`. The remaining values are
 * read-only legacy compatibility for rows created before internal channels and
 * direct external messaging were retired.
 *
 * Mapping rationale:
 *   silent       → L1   no completion Notification
 *   notification → L2   completion Notification
 *   channel      → L2   legacy channel report, now Notification
 *   default      → L2   legacy default, now Notification
 *   kakao/all    → L4   legacy urgent report, now high-priority Notification
 */
export function severityFromReportPolicy(policy: string | null | undefined): TowerSeverity {
  switch (policy) {
    case 'silent':
      return 'L1';
    case 'kakao':
    case 'all':
      return 'L4';
    case 'notification':
    case 'channel':
    case 'default':
    default:
      return 'L2';
  }
}

// ── Routing decisions ────────────────────────────────────────────────

export interface SeverityRoute {
  /** Whether to create an in-app Notification report. */
  notifyInApp: boolean;
  /** Whether the message should @mention recipients (drives OS push later). */
  mention: boolean;
  /** Whether to create a Board issue alongside the post (Phase 3). */
  boardIssue: boolean;
}

/**
 * Decide what Tower should do for a given severity. Used by callers to gate
 * the appropriate side effects without sprinkling switch statements.
 *
 *   L1 → nothing (silent)
 *   L2 → Notification only
 *   L3 → Notification + Board issue (future policy surface)
 *   L4 → high-priority Notification + Board issue
 */
export function routeSeverity(severity: TowerSeverity): SeverityRoute {
  switch (severity) {
    case 'L1':
      return { notifyInApp: false, mention: false, boardIssue: false };
    case 'L2':
      return { notifyInApp: true, mention: false, boardIssue: false };
    case 'L3':
      return { notifyInApp: true, mention: false, boardIssue: true };
    case 'L4':
      return { notifyInApp: true, mention: true, boardIssue: true };
  }
}
