import { monitorQueue } from "../monitor.queue";




export async function scheduleMonitor(
  monitorId: number,
  url: string,
  intervalSeconds: number
) {
  // Use the modern Job Scheduler API instead of queue.add()
  await monitorQueue.upsertJobScheduler(
    `monitor:${monitorId}`,
    { every: intervalSeconds * 1000 },
    {
      name: "check",
      data: { monitorId, url, intervalSeconds },
      opts: {
        removeOnComplete: true,
        removeOnFail: false,
      }
    }
  );
}

export async function removeMonitorJob(monitorId: number) {
  const schedulerId = `monitor:${monitorId}`;
  
  // 1. Destroy the meta-configuration to stop future generation
  await monitorQueue.removeJobScheduler(schedulerId);

  // 2. Fetch pending delayed jobs to catch the orphaned instance
  const delayedJobs = await monitorQueue.getDelayed();

  // 3. Filter and manually purge any remaining concrete instances
  const orphanedJobs = delayedJobs.filter(job => 
    job.id && job.id.includes(schedulerId)
  );

  for (const job of orphanedJobs) {
    try {
      await job.remove();
    } catch (error) {
      console.error(`Failed to manually purge orphaned delayed job:`, error);
    }
  }
}