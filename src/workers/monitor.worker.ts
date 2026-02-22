import { Worker, Job } from "bullmq";
import { runFullProbe } from "../modules/probe/probe.service";
import { db } from "../core/db/client";
import { sendAlert } from "../modules/notifications/notifier";
import { openIncident, resolveIncident } from "../modules/incident/incident.service";
import { connectionOptions } from "../core/queue/redis";
import { classifyFailure } from "../domain/diagnostics/root-cause.classifier";
import { getCertificateExpiry } from "../domain/diagnostics/tls-expiry.checker";
import { sendTlsExpiryAlert } from "../modules/notifications/email.provider";
import { isInMaintenance } from "../domain/maintenance/maintenance.checker";

/**
 * RULES
 * -----
 * DOWN: 3 consecutive failures
 * UP:   2 consecutive successes after DOWN
 */

const FAILURE_THRESHOLD = 3;
const RECOVERY_THRESHOLD = 2;

const worker = new Worker(
  "monitor-check",
  async (job: Job) => {
    const { monitorId, url } = job.data;

    // -----------------------------
    // 1️⃣ Verify monitor still exists
    // -----------------------------
    const monitorRow = db
      .prepare(`
        SELECT id, user_id, confirmed_status, consecutive_failures, consecutive_successes,
               tls_expiry_at, tls_alerted_days
        FROM monitors
        WHERE id = ?
      `)
      .get(monitorId) as any;

    if (!monitorRow) {
      console.log(`⚠️ Ignoring stale job for deleted monitor ${monitorId}`);
      return;
    }

    let failures = monitorRow.consecutive_failures ?? 0;
    let successes = monitorRow.consecutive_successes ?? 0;
    let confirmedStatus = monitorRow.confirmed_status ?? "UP";

    // -----------------------------
    // 2️⃣ Run probe
    // -----------------------------
    const { diagnosis, dns, tcp, tls, http } = await runFullProbe(url);
    const rootCause = classifyFailure({ dns, tcp, tls, http });
    const currentStatus: "UP" | "DOWN" | "SLOW" = diagnosis.status;

    // Check maintenance window
    const inMaintenance = isInMaintenance(monitorId);

    // If it was in maintenance previously but not anymore, reset to UP
    if (confirmedStatus === "MAINTENANCE" && !inMaintenance) {
      confirmedStatus = "UP";
      // Ensure any lingering incidents from before maintenance are explicitly resolved
      resolveIncident(monitorId);
    }

    // -----------------------------
    // 3️⃣ Failure handling
    // -----------------------------
    if (currentStatus === "DOWN" && !inMaintenance) {
      failures++;
      successes = 0;

      console.log(`⚠️ ${url} failure ${failures}/${FAILURE_THRESHOLD}`);

      if (failures >= FAILURE_THRESHOLD && confirmedStatus !== "DOWN") {
        confirmedStatus = "DOWN";

        // 🔴 Record incident start
        if (!inMaintenance) {
          openIncident(monitorId, rootCause);
        }

        console.log(`🚨 CONFIRMED DOWN: ${url}`);

        if (!inMaintenance) {
          await sendAlert({
            monitorId,
            url,
            status: "DOWN",
            checkedAt: new Date(),
          });
        }
      }
    }

    // -----------------------------
    // 4️⃣ Recovery handling
    // -----------------------------
    else {
      successes++;
      failures = 0;

      if (confirmedStatus === "DOWN") {
        console.log(`🧪 Recovery check ${successes}/${RECOVERY_THRESHOLD} for ${url}`);
      }

      if (confirmedStatus === "DOWN" && successes >= RECOVERY_THRESHOLD) {
        confirmedStatus = "UP";

        // 🟢 Resolve open incident
        if (!inMaintenance) {
          resolveIncident(monitorId);
        }

        console.log(`🟢 RECOVERED: ${url}`);

        if (!inMaintenance) {
          await sendAlert({
            monitorId,
            url,
            status: "UP",
            checkedAt: new Date(),
          });
        }
      }
    }

    // -----------------------------
    // 5️⃣ Persist monitor state
    // -----------------------------
    let tlsExpiryAt: string | null = monitorRow.tls_expiry_at ?? null;
    let tlsAlertedDays: string = monitorRow.tls_alerted_days ?? "";

    // -----------------------------
    // 5.5️⃣ TLS certificate expiry check
    // -----------------------------
    try {
      const hostname = new URL(url).hostname;
      const expiryDate = await getCertificateExpiry(hostname);

      if (expiryDate) {
        tlsExpiryAt = expiryDate.toISOString();
        const now = new Date();
        const daysLeft = (expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

        const alertedSet = new Set(
          tlsAlertedDays ? tlsAlertedDays.split(",").map(Number) : []
        );

        // If cert renewed (expiry > 7 days), reset alerts
        if (daysLeft > 7) {
          if (alertedSet.size > 0) {
            console.log(`🔄 TLS cert renewed for ${url}, resetting alerts`);
          }
          tlsAlertedDays = "";
        } else {
          // Determine which threshold to alert on
          let threshold: number | null = null;
          if (daysLeft <= 1 && !alertedSet.has(1)) {
            threshold = 1;
          } else if (daysLeft <= 3 && !alertedSet.has(3)) {
            threshold = 3;
          } else if (daysLeft <= 7 && !alertedSet.has(7)) {
            threshold = 7;
          }

          if (threshold !== null) {
            // Look up owner email
            const owner = db
              .prepare(`SELECT email FROM users WHERE id = ?`)
              .get(monitorRow.user_id) as any;

            if (owner?.email) {
              await sendTlsExpiryAlert(owner.email, url, expiryDate, daysLeft);
            }

            alertedSet.add(threshold);
            tlsAlertedDays = Array.from(alertedSet).join(",");
            console.log(`🔔 TLS expiry alert sent for ${url} — ${Math.floor(daysLeft)}d left (threshold: ${threshold}d)`);
          } else {
            console.log(`🔒 TLS cert for ${url} expires in ${Math.floor(daysLeft)}d (already alerted)`);
          }
        }
      }
    } catch (err) {
      console.error(`⚠️ TLS expiry check failed for ${url}:`, err);
    }

    // During maintenance, store MAINTENANCE as the status
    const finalStatus = inMaintenance ? "MAINTENANCE" : confirmedStatus;

    db.prepare(`
      UPDATE monitors
      SET
        consecutive_failures = ?,
        consecutive_successes = ?,
        confirmed_status = ?,
        tls_expiry_at = ?,
        tls_alerted_days = ?,
        in_maintenance = ?
      WHERE id = ?
    `).run(failures, successes, finalStatus, tlsExpiryAt, tlsAlertedDays, inMaintenance ? 1 : 0, monitorId);

    // -----------------------------
    // 6️⃣ Store probe history
    // -----------------------------
    // Store probe result with finalStatus (MAINTENANCE during maintenance windows)
    const probeStatus = inMaintenance ? "MAINTENANCE" : currentStatus;

    db.prepare(`
      INSERT INTO probe_results
      (monitor_id, dns, tcp, tls, ttfb, status, root_cause, http_status_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      monitorId,
      dns?.time ?? null,
      tcp?.time ?? null,
      tls?.time ?? null,
      http?.ttfb ?? null,
      probeStatus,
      rootCause,
      http?.statusCode ?? null,
    );
  },
  {
    connection: connectionOptions,

    // IMPORTANT: SQLite safety
    concurrency: 1,
  }
);

// -----------------------------
// Worker lifecycle logging
// -----------------------------
worker.on("ready", () => {
  console.log("🟢 Monitor worker connected to Redis");
});

worker.on("active", (job) => {
  console.log(`🔎 Checking ${job.data.url}`);
});

worker.on("completed", (job) => {
  console.log(`✅ Completed ${job.data.url}`);
});

worker.on("failed", (job, err) => {
  console.log(`❌ Failed ${job?.data?.url}`, err.message);
});

worker.on("error", (err) => {
  console.error("Worker error:", err);
});

// keep process alive
process.stdin.resume();

// graceful shutdown
process.on("SIGINT", async () => {
  await worker.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await worker.close();
  process.exit(0);
});
