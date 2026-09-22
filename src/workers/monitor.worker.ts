import { Worker, Job } from "bullmq";
import { connectionOptions } from "../core/queue/redis";
import { processMonitor } from "../modules/monitor/check-runner";

const worker = new Worker(
  "monitor-check",
  async (job: Job<{ monitorId: number }>) => {
    await processMonitor(job.data.monitorId);
  },
  {
    connection: connectionOptions,
    // Each check is mostly waiting on the network, so the old limit of 1 left
    // the process idle between probes. Postgres handling concurrent writers
    // is what made raising this safe — SQLite did not.
    concurrency: Number(process.env.WORKER_CONCURRENCY) || 10,
  }
);

worker.on("ready", () => console.log("🟢 Monitor worker connected to Redis"));
worker.on("failed", (job, err) =>
  console.error(`❌ Check failed for monitor ${job?.data?.monitorId}:`, err.message)
);
worker.on("error", (err) => console.error("Worker error:", err));

// keep process alive
process.stdin.resume();

async function shutdown() {
  await worker.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
