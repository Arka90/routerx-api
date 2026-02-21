import { Worker } from "bullmq";
import { connectionOptions } from "../core/queue/redis";
import { generateWeeklyReports } from "../modules/reports/report.service";

const worker = new Worker(
  "weekly-report",
  async () => {
    console.log("📊 Running weekly report generation…");
    await generateWeeklyReports();
  },
  { connection: connectionOptions }
);

// Lifecycle logging
worker.on("ready", () => {
  console.log("🟢 Report worker connected to Redis");
});

worker.on("completed", () => {
  console.log("✅ Weekly report job completed");
});

worker.on("failed", (_job, err) => {
  console.error("❌ Weekly report job failed:", err.message);
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
