import { Worker, Job } from "bullmq";
import { connectionOptions } from "../core/queue/redis";
import { generateWeeklyReports } from "../modules/reports/report.service";
import { pruneExpiredData } from "../core/db/retention";

const worker = new Worker(
  "weekly-report",
  async (job: Job) => {
    if (job.name === "retention") {
      const summary = pruneExpiredData();
      console.log(
        `🧹 Pruned ${summary.probeResults} probe result(s), ` +
          `${summary.otpCodes} expired login code(s), ` +
          `${summary.sessions} expired session(s)`
      );
      return;
    }

    console.log("📊 Running weekly report generation…");
    await generateWeeklyReports();
  },
  { connection: connectionOptions }
);

// Lifecycle logging
worker.on("ready", () => {
  console.log("🟢 Report worker connected to Redis");
});

worker.on("completed", (job) => {
  console.log(`✅ Job completed: ${job.name}`);
});

worker.on("failed", (job, err) => {
  console.error(`❌ Job failed (${job?.name}):`, err.message);
});

worker.on("error", (err) => {
  console.error("Report worker error:", err);
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
