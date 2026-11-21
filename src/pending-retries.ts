// Pure-logic helpers for the persistent scheduled-task retry queue.
//
// The scheduler used to keep busy-skipped tasks in an in-memory Map and
// abandon them after 15-60 minutes, silently. The replacement policy is:
//
//   1. Every busy retry is upserted into `pending_task_retries` (persists
//      across dashboard restarts, so nothing is dropped).
//   2. On every tick, the scheduler tries to fire every pending row. On
//      success, the row is deleted; on continued busy, attempt_count ++.
//   3. If a row has been waiting longer than `ALERT_THRESHOLD_MS` and
//      `alert_sent_at` is null, the alerting layer stamps the row BEFORE
//      sending the channel alert (so concurrent ticks do not double-alert)
//      and clears the stamp if the send fails (so the next tick can retry).
//      The scheduled task itself keeps retrying forever -- we do NOT abandon.

/**
 * How long a busy-skipped scheduled task can wait before we escalate to the
 * operator via Discord. The retry itself continues forever: this is the
 * alerting threshold, not an abandon threshold.
 */
export const ALERT_THRESHOLD_MS = 60 * 60 * 1000

/**
 * Additional wait AFTER the main-agent-notice threshold (ALERT_THRESHOLD_MS)
 * before escalating directly to the operator via the channel provider. Two
 * independent, one-shot stamps (`alert_sent_at` for the main-agent notice,
 * `owner_alert_sent_at` for the direct escalation) both key off
 * `first_attempt`, not off each other.
 */
export const OWNER_ESCALATION_EXTRA_MS = 75 * 60 * 1000
export const OWNER_ALERT_THRESHOLD_MS = ALERT_THRESHOLD_MS + OWNER_ESCALATION_EXTRA_MS

/**
 * Decide whether the alerting layer should fire a notification
 * for a pending retry row.
 */
export function shouldSendAlert(
  now: number,
  firstAttempt: number,
  alertSentAt: number | null,
  thresholdMs: number = ALERT_THRESHOLD_MS,
): boolean {
  if (alertSentAt != null) return false
  if (!Number.isFinite(firstAttempt) || firstAttempt <= 0) return false
  if (!Number.isFinite(now) || now < firstAttempt) return false
  return now - firstAttempt > thresholdMs
}

/**
 * Classify a Discord send failure as transient (worth retrying) or
 * permanent (a config / client error that will fail identically every tick).
 *
 * Discord (`discordProvider.sendMessage`) throws `Error("Discord API <status>: <body>")`
 * on a non-2xx response. A bare network error carries no status and retries.
 */
export function classifySendError(errMessage: string): 'transient' | 'permanent' {
  if (errMessage.includes('Discord API')) return classifyDiscordError(errMessage)
  return 'transient' // no recognized provider prefix -> network-level failure
}

/** Shared HTTP-status policy: 429 and 5xx retry, other 4xx is config. */
function classifyHttpStatus(status: number): 'transient' | 'permanent' {
  if (status === 429 || status >= 500) return 'transient'
  if (status >= 400) return 'permanent'
  return 'transient'
}

/** Discord (discordProvider.sendMessage): "Discord API <status>: <body>". */
function classifyDiscordError(errMessage: string): 'transient' | 'permanent' {
  const match = /Discord API (\d{3})\b/.exec(errMessage)
  return match ? classifyHttpStatus(Number(match[1])) : 'transient'
}

/**
 * Shape of a pending retry used by the UI + the alert layer. A small
 * subset of the DB row, decoupled from the DB type so tests don't need
 * better-sqlite3.
 */
export interface PendingRetryView {
  id: number
  taskName: string
  agentName: string
  firstAttempt: number
  lastAttempt: number
  attemptCount: number
  lastReason: string | null
  alertSentAt: number | null
  ageMs: number
  alertDue: boolean
  ownerAlertSentAt: number | null
  ownerAlertDue: boolean
}

/**
 * Project a raw DB row into the UI view, including the derived `ageMs`
 * (for display) and `alertDue` (= shouldSendAlert).
 */
export function toPendingRetryView(
  row: {
    id: number
    task_name: string
    agent_name: string
    first_attempt: number
    last_attempt: number
    attempt_count: number
    last_reason: string | null
    alert_sent_at: number | null
    owner_alert_sent_at?: number | null
  },
  now: number,
  thresholdMs: number = ALERT_THRESHOLD_MS,
  ownerThresholdMs: number = OWNER_ALERT_THRESHOLD_MS,
): PendingRetryView {
  return {
    id: row.id,
    taskName: row.task_name,
    agentName: row.agent_name,
    firstAttempt: row.first_attempt,
    lastAttempt: row.last_attempt,
    attemptCount: row.attempt_count,
    lastReason: row.last_reason,
    alertSentAt: row.alert_sent_at,
    ageMs: Math.max(0, now - row.first_attempt),
    alertDue: shouldSendAlert(now, row.first_attempt, row.alert_sent_at, thresholdMs),
    ownerAlertSentAt: row.owner_alert_sent_at ?? null,
    ownerAlertDue: shouldSendAlert(now, row.first_attempt, row.owner_alert_sent_at ?? null, ownerThresholdMs),
  }
}
