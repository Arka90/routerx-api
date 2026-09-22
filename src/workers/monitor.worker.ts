import { Worker, Job } from "bullmq";
import { connectionOptions } from "../core/queue/redis";
import { monitorQueueName } from "../core/queue/monitor.queue";
import { config } from "../core/config";
import { processMonitor } from "../modules/monitor/check-runner";
import { ensureRegion } from "../modules/regions/region.service";
import { closePool } from "../core/db/client";

/**
 * A worker consumes only its own region's queue. BullMQ cannot filter by job
 * payload, so the region has to be part of the queue name — which is also
 * what makes bringing up a probe in a new location a deploy rather than a
 * code change.
 */
const queueName = monitorQueueName(config.region);

const worker = new Worker(
  queueName,
  async (job: Job<{ monitorId: number; region?: string }>) => {
    await processMonitor(job.data.monitorId, job.data.region ?? config.region);
  },
  {
    connection: connectionOptions,
    // Each check is mostly waiting on the network, so the old limit of 1 left
    // the process idle between probes. Postgres handling concurrent writers
    // is what made raising this safe — SQLite did not.
    concurrency: Number(process.env.WORKER_CONCURRENCY) || 10,
  }
);

worker.on("ready", async () => {
  console.log(`🟢 Monitor worker ready — region "${config.region}" (${queueName})`);

  try {
    // Announce the region so the API can offer it and the scheduler can fan
    // monitors out to it on its next sync.
    await ensureRegion(config.region, config.regionName);
  } catch (error) {
    console.error("Could not register this worker's region:", error);
  }
});

worker.on("failed", (job, err) =>
  console.error(`❌ Check failed for monitor ${job?.data?.monitorId}:`, err.message)
);

worker.on("error", (err) => console.error("Worker error:", err));

// keep process alive
process.stdin.resume();

async function shutdown() {
  await worker.close();
  await closePool().catch(() => undefined);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
