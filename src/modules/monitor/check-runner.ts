/**
 * The check state machine.
 *
 * Kept separate from the BullMQ worker so it can be driven directly in tests:
 * importing the worker module would open a Redis connection and start
 * consuming jobs.
 */
import { execute, query, queryOne } from "../../core/db/client";
import { runCheck } from "../probe/probe.service";
import { getMonitorForCheck } from "./monitor.service";
import {
  getOpenIncident,
  markNotified,
  openIncident,
  resolveIncident,
} from "../incident/incident.service";
import { dispatchAlert } from "../notifications/notifier";
import { sendTlsExpiryAlert } from "../notifications/transactional";
import { announceIncident } from "../status-pages/announcer";
import { isInMaintenance } from "../../domain/maintenance/maintenance.checker";
import { getCertificateExpiry } from "../../domain/diagnostics/tls-expiry.checker";
import {
  getQuorumStates,
  resolveMonitorRegions,
  saveRegionState,
  type MonitorRegionState,
} from "../regions/region.service";
import { advanceRegionState, evaluateQuorum } from "./quorum";
import type { MonitorWithPolicy } from "./monitor.types";

const TLS_ALERT_THRESHOLDS = [7, 3, 1];

async function organizationName(orgId: number): Promise<string> {
  const row = await queryOne<{ name: string }>(
    `SELECT name FROM organizations WHERE id = $1`,
    [orgId]
  );

  return row?.name ?? "your workspace";
}

function isMuted(monitor: MonitorWithPolicy): boolean {
  const { muted_until: mutedUntil } = monitor.policy;
  return mutedUntil !== null && new Date(mutedUntil) > new Date();
}

/**
 * TLS expiry is tracked separately from up/down: a certificate that expires
 * on Saturday is a Monday problem, not an outage yet.
 */
async function checkCertificateExpiry(monitor: MonitorWithPolicy): Promise<{
  expiresAt: Date | null;
  alertedDays: number[];
}> {
  const hostname = new URL(monitor.url).hostname;
  const expiryDate = await getCertificateExpiry(hostname);

  if (!expiryDate) {
    return { expiresAt: monitor.tls_expiry_at, alertedDays: monitor.tls_alerted_days };
  }

  const daysLeft = (expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  const alerted = new Set(monitor.tls_alerted_days);

  // A renewal pushes expiry back out; clear the history so the next approach
  // alerts again.
  if (daysLeft > TLS_ALERT_THRESHOLDS[0]) {
    return { expiresAt: expiryDate, alertedDays: [] };
  }

  const threshold = TLS_ALERT_THRESHOLDS.find(
    (days) => daysLeft <= days && !alerted.has(days)
  );

  if (threshold === undefined) {
    return { expiresAt: expiryDate, alertedDays: [...alerted] };
  }

  const recipients = await query<{ email: string }>(
    `SELECT u.email::text AS email
       FROM org_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1`,
    [monitor.org_id]
  );

  try {
    await sendTlsExpiryAlert(
      recipients.map((row) => row.email),
      monitor.url,
      expiryDate,
      daysLeft
    );
    alerted.add(threshold);
  } catch (error) {
    // Leave the threshold unrecorded so the next run tries again.
    console.error(`TLS expiry alert failed for ${monitor.url}:`, error);
  }

  return { expiresAt: expiryDate, alertedDays: [...alerted] };
}

const EMPTY_STATE = {
  status: "UNCONFIRMED" as const,
  consecutive_failures: 0,
  consecutive_successes: 0,
};

/**
 * Run one check of `monitorId` from `region` and fold the result into both
 * that region's state and the monitor's overall verdict.
 */
export async function processMonitor(
  monitorId: number,
  region = "default"
): Promise<void> {
  const monitor = await getMonitorForCheck(monitorId);

  if (!monitor) {
    console.log(`Ignoring stale job for deleted monitor ${monitorId}`);
    return;
  }

  if (monitor.paused) {
    console.log(`Skipping paused monitor ${monitorId}`);
    return;
  }

  const policy = monitor.policy;
  const inMaintenance = await isInMaintenance(monitorId);
  const regions = await resolveMonitorRegions(monitor.regions ?? []);

  const outcome = await runCheck({
    url: monitor.url,
    method: monitor.method,
    request_headers: monitor.request_headers ?? {},
    request_body: monitor.request_body,
    expected_status_codes: monitor.expected_status_codes ?? [],
    assertion_type: monitor.assertion_type,
    assertion_value: monitor.assertion_value,
    timeout_ms: monitor.timeout_ms,
    follow_redirects: monitor.follow_redirects,
    slow_threshold_ms: policy.slow_threshold_ms,
  });

  // A SLOW verdict only counts against the monitor when the policy says to
  // care. Otherwise it is recorded but treated as a success.
  const degraded = outcome.status === "SLOW" && policy.alert_on_slow;
  const failed = outcome.status === "DOWN" || degraded;

  const context = {
    orgId: monitor.org_id,
    organizationName: await organizationName(monitor.org_id),
    monitor: { id: monitor.id, name: monitor.name, url: monitor.url },
    channelIds: monitor.channel_ids,
  };

  let confirmed: MonitorWithPolicy["confirmed_status"] = monitor.confirmed_status;
  let failures = monitor.consecutive_failures;
  let successes = monitor.consecutive_successes;

  if (inMaintenance) {
    // Count nothing and alert on nothing; the window exists precisely so a
    // planned deploy does not read as an outage. The region's streaks reset
    // so the first check afterwards starts from a clean slate.
    confirmed = "MAINTENANCE";
    failures = 0;
    successes = 0;

    await saveRegionState({
      monitor_id: monitor.id,
      region,
      ...EMPTY_STATE,
      last_checked_at: null,
      last_root_cause: null,
      last_detail: null,
    });
  } else {
    const previous =
      (await getQuorumStates(monitor.id, [region]))[0] ??
      ({ ...EMPTY_STATE } as MonitorRegionState);

    const next = advanceRegionState(previous, failed, degraded, {
      failureThreshold: policy.failure_threshold,
      recoveryThreshold: policy.recovery_threshold,
    });

    await saveRegionState({
      monitor_id: monitor.id,
      region,
      status: next.status,
      consecutive_failures: next.consecutive_failures,
      consecutive_successes: next.consecutive_successes,
      last_checked_at: null,
      last_root_cause: outcome.rootCause,
      last_detail: outcome.detail,
    });

    const states = await getQuorumStates(monitor.id, regions);

    const quorum = evaluateQuorum({
      states,
      regions,
      confirmations: policy.confirmations,
      current: monitor.confirmed_status,
    });

    const wasFailing =
      monitor.confirmed_status === "DOWN" || monitor.confirmed_status === "DEGRADED";
    const nowFailing = quorum.verdict === "DOWN" || quorum.verdict === "DEGRADED";

    confirmed = quorum.verdict;
    failures = nowFailing ? failures + 1 : 0;
    successes = nowFailing ? 0 : successes + 1;

    if (nowFailing && !wasFailing) {
      const incident = await openIncident(
        monitor.id,
        outcome.rootCause,
        outcome.detail,
        quorum.failingRegions
      );

      if (!isMuted(monitor)) {
        await dispatchAlert({
          ...context,
          type: quorum.verdict === "DEGRADED" ? "DEGRADED" : "DOWN",
          headline: quorum.verdict === "DEGRADED" ? "Degraded" : "Down",
          rootCause: outcome.rootCause,
          detail: describeRegions(outcome.detail, quorum.failingRegions, regions),
          incidentId: incident?.id ?? null,
        });

        if (incident) await markNotified(incident.id);
      }

      if (incident) await announceIncident(monitor.id, incident.id, "opened");
    } else if (!nowFailing && wasFailing) {
      const incident = await resolveIncident(monitor.id);

      if (!isMuted(monitor)) {
        await dispatchAlert({
          ...context,
          type: "UP",
          headline: "Recovered",
          incidentId: incident?.id ?? null,
          durationSeconds: incident?.duration_seconds ?? null,
        });
      }

      if (incident) await announceIncident(monitor.id, incident.id, "resolved");
    } else if (nowFailing && policy.renotify_minutes !== null && !isMuted(monitor)) {
      // Still broken. Nag on the configured cadence so an unacknowledged
      // outage does not go quiet after the first message.
      const incident = await getOpenIncident(monitor.id);

      const due =
        incident !== null &&
        incident.acknowledged_at === null &&
        (incident.last_notified_at === null ||
          Date.now() - new Date(incident.last_notified_at).getTime() >=
            policy.renotify_minutes * 60 * 1000);

      if (due && incident) {
        await dispatchAlert({
          ...context,
          type: "REMINDER",
          headline: "Still down",
          rootCause: outcome.rootCause,
          detail: describeRegions(outcome.detail, quorum.failingRegions, regions),
          incidentId: incident.id,
        });

        await markNotified(incident.id);
      }
    }
  }

  // Certificate checks are skipped when the target was refused — connecting
  // to fetch the certificate is exactly what the SSRF guard just prevented.
  let tlsExpiry = monitor.tls_expiry_at;
  let tlsAlerted = monitor.tls_alerted_days;

  if (!outcome.blocked && monitor.url.startsWith("https://")) {
    try {
      const result = await checkCertificateExpiry(monitor);
      tlsExpiry = result.expiresAt;
      tlsAlerted = result.alertedDays;
    } catch (error) {
      console.error(`TLS expiry check failed for ${monitor.url}:`, error);
    }
  }

  await execute(
    `UPDATE monitors
        SET consecutive_failures = $2,
            consecutive_successes = $3,
            confirmed_status = $4,
            tls_expiry_at = $5,
            tls_alerted_days = $6,
            in_maintenance = $7
      WHERE id = $1`,
    [monitor.id, failures, successes, confirmed, tlsExpiry, tlsAlerted, inMaintenance]
  );

  await execute(
    `INSERT INTO probe_results
       (monitor_id, region, dns, tcp, tls, ttfb, status, http_status_code,
        root_cause, failure_detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      monitor.id,
      region,
      outcome.timings.dns,
      outcome.timings.tcp,
      outcome.timings.tls,
      outcome.timings.ttfb,
      inMaintenance ? "MAINTENANCE" : outcome.status,
      outcome.statusCode,
      outcome.rootCause,
      outcome.detail?.slice(0, 500) ?? null,
    ]
  );
}

/**
 * "Failing from eu-west and us-east (2 of 3 regions)" is the difference
 * between a routing problem and an outage, and it is the first thing anyone
 * asks when the page fires.
 */
function describeRegions(
  detail: string | null,
  failingRegions: string[],
  regions: string[]
): string | null {
  if (regions.length <= 1 || failingRegions.length === 0) return detail;

  const summary = `Failing from ${failingRegions.join(", ")} (${failingRegions.length} of ${regions.length} regions)`;

  return detail ? `${summary}. ${detail}` : summary;
}
