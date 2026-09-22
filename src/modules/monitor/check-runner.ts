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
import { isInMaintenance } from "../../domain/maintenance/maintenance.checker";
import { getCertificateExpiry } from "../../domain/diagnostics/tls-expiry.checker";
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

export async function processMonitor(monitorId: number): Promise<void> {
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
  // care. Otherwise it is recorded but treated as a success, which is the
  // old behaviour.
  const treatAsFailure =
    outcome.status === "DOWN" || (outcome.status === "SLOW" && policy.alert_on_slow);

  let failures = monitor.consecutive_failures;
  let successes = monitor.consecutive_successes;
  let confirmed = monitor.confirmed_status;

  const context = {
    orgId: monitor.org_id,
    organizationName: await organizationName(monitor.org_id),
    monitor: { id: monitor.id, name: monitor.name, url: monitor.url },
    channelIds: monitor.channel_ids,
  };

  if (inMaintenance) {
    // Count nothing and alert on nothing; the window exists precisely so a
    // planned deploy does not read as an outage.
    failures = 0;
    successes = 0;
    confirmed = "MAINTENANCE";
  } else if (treatAsFailure) {
    failures += 1;
    successes = 0;

    const failureState = outcome.status === "SLOW" ? "DEGRADED" : "DOWN";
    const alreadyFailing = confirmed === "DOWN" || confirmed === "DEGRADED";

    if (failures >= policy.failure_threshold && !alreadyFailing) {
      confirmed = failureState;

      const incident = await openIncident(
        monitor.id,
        outcome.rootCause,
        outcome.detail
      );

      if (!isMuted(monitor)) {
        await dispatchAlert({
          ...context,
          type: failureState === "DEGRADED" ? "DEGRADED" : "DOWN",
          headline: failureState === "DEGRADED" ? "Degraded" : "Down",
          rootCause: outcome.rootCause,
          detail: outcome.detail,
          incidentId: incident?.id ?? null,
        });

        if (incident) await markNotified(incident.id);
      }
    } else if (alreadyFailing && policy.renotify_minutes !== null && !isMuted(monitor)) {
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
          detail: outcome.detail,
          incidentId: incident.id,
        });

        await markNotified(incident.id);
      }
    }
  } else {
    successes += 1;
    failures = 0;

    const wasFailing = confirmed === "DOWN" || confirmed === "DEGRADED";

    if (wasFailing && successes >= policy.recovery_threshold) {
      confirmed = "UP";

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
    } else if (confirmed === "UNCONFIRMED" || confirmed === "MAINTENANCE") {
      // Leaving a maintenance window, or reporting for the first time.
      confirmed = "UP";
      await resolveIncident(monitor.id);
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
    [
      monitor.id,
      failures,
      successes,
      confirmed,
      tlsExpiry,
      tlsAlerted,
      inMaintenance,
    ]
  );

  await execute(
    `INSERT INTO probe_results
       (monitor_id, dns, tcp, tls, ttfb, status, http_status_code, root_cause, failure_detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      monitor.id,
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

