import { reportQueue } from "../report.queue";

export async function scheduleWeeklyReport() {
  // Left on the legacy repeat API on purpose: this job is already registered
  // in Redis on the live deployment, and switching it to a job scheduler
  // risks the old registration surviving alongside the new one and mailing
  // every user twice. Migrate it deliberately, not as a side effect.
  await reportQueue.add(
    "weekly",
    {},
    {
      repeat: {
        pattern: "0 9 * * 1", // Monday 09:00
      },
      jobId: "weekly-report",
    }
  );

  console.log("📊 Weekly report scheduled (Monday 9 AM)");
}

/**
 * Daily prune. Shares the report queue rather than adding a fourth container:
 * both jobs are infrequent, single-shot, and safe to run on one worker.
 */
export async function scheduleRetention() {
  await reportQueue.upsertJobScheduler(
    "data-retention",
    { pattern: "30 3 * * *" }, // 03:30 daily, away from the weekly report
    { name: "retention", data: {} }
  );

  console.log("🧹 Data retention scheduled (daily 03:30)");
}
