import { Worker, Job } from "bullmq";
import { runFullProbe } from "../modules/probe/probe.service";
import { db } from "../core/db/client";
import { sendAlert } from "../modules/notifications/notifier";
import { connectionOptions } from "../core/queue/redis";


const worker = new Worker(
  "monitor-check",
  async (job: Job) => {
    const { monitorId, url, intervalSeconds } = job.data;

    const { diagnosis, dns, tcp, tls, http } = await runFullProbe(url);

    const last = db
      .prepare(`
        SELECT status
        FROM probe_results
        WHERE monitor_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .get(monitorId) as any;

    const previousStatus = last?.status;
    const currentStatus = diagnosis.status;
    const alertStatus: 'UP' | 'DOWN' = currentStatus === 'DOWN' ? 'DOWN' : 'UP';

    if (previousStatus && previousStatus !== currentStatus) {
      await sendAlert({
        monitorId,
        url,
        status: alertStatus,
        checkedAt: new Date(),
      });
    }

    db.prepare(`
      INSERT INTO probe_results
      (monitor_id, dns, tcp, tls, ttfb, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      monitorId,
      dns.time,
      tcp?.time,
      tls?.time,
      http?.ttfb,
      currentStatus
    );

  },
  {
    connection: connectionOptions,
    concurrency: 5, // MASSIVE feature
  }
);

// --- ADD THIS PART ---

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

// 🔥 KEEP PROCESS ALIVE
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