import { Worker, Job } from "bullmq";
import { runFullProbe } from "../modules/probe/probe.service";
import { db } from "../core/db/client";
import { sendAlert } from "../modules/notifications/notifier";
import { openIncident, resolveIncident } from "../modules/incident/incident.service";
import { connectionOptions } from "../core/queue/redis";

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
        SELECT id, confirmed_status, consecutive_failures, consecutive_successes
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
    const currentStatus: "UP" | "DOWN" | "SLOW" = diagnosis.status;

    // -----------------------------
    // 3️⃣ Failure handling
    // -----------------------------
    if (currentStatus === "DOWN") {
      failures++;
      successes = 0;

      console.log(`⚠️ ${url} failure ${failures}/${FAILURE_THRESHOLD}`);

      if (failures >= FAILURE_THRESHOLD && confirmedStatus !== "DOWN") {
        confirmedStatus = "DOWN";

        // 🔴 Record incident start
        openIncident(monitorId);

        console.log(`🚨 CONFIRMED DOWN: ${url}`);

        // await sendAlert({
        //   monitorId,
        //   url,
        //   status: "DOWN",
        //   checkedAt: new Date(),
        // });
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
        resolveIncident(monitorId);

        console.log(`🟢 RECOVERED: ${url}`);

        // await sendAlert({
        //   monitorId,
        //   url,
        //   status: "UP",
        //   checkedAt: new Date(),
        // });
      }
    }

    // -----------------------------
    // 5️⃣ Persist monitor state
    // -----------------------------
    db.prepare(`
      UPDATE monitors
      SET
        consecutive_failures = ?,
        consecutive_successes = ?,
        confirmed_status = ?
      WHERE id = ?
    `).run(failures, successes, confirmedStatus, monitorId);

    // -----------------------------
    // 6️⃣ Store probe history
    // -----------------------------
    db.prepare(`
      INSERT INTO probe_results
      (monitor_id, dns, tcp, tls, ttfb, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      monitorId,
      dns?.time ?? null,
      tcp?.time ?? null,
      tls?.time ?? null,
      http?.ttfb ?? null,
      currentStatus
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
