import { monitorQueue } from "./monitor.queue";



export async function scheduleMonitor(
  monitorId: number,
  url: string,
  intervalSeconds: number
) {
  await monitorQueue.add(
    "check",
    { monitorId, url, intervalSeconds },
    {
      jobId: `monitor:${monitorId}`,
      repeat: {
        every: intervalSeconds * 1000,
      },
      removeOnComplete: true,
      removeOnFail: false,
    }
  );
}

export async function removeMonitorJob(monitorId: number) {
  const jobs = await monitorQueue.getRepeatableJobs();

  for (const job of jobs) {
    if (job.id === `monitor:${monitorId}`) {
      await monitorQueue.removeRepeatableByKey(job.key);
    }
  }
}
