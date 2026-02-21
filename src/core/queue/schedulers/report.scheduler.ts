import { reportQueue } from "../report.queue";

export async function scheduleWeeklyReport() {
  await reportQueue.add(
    "weekly",
    {},
    {
      repeat: {
        pattern: "0 9 * * 1", // Monday 9:00 AM
      },
      jobId: "weekly-report",
    }
  );

  console.log("📊 Weekly report scheduled (Monday 9 AM)");
}
