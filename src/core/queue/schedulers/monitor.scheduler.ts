import { monitorQueue } from "../monitor.queue";

function schedulerId(monitorId: number): string {
  return `monitor:${monitorId}`;
}

/**
 * The job carries only the monitor id. It used to carry the url and interval
 * too, which meant an edited monitor kept being checked against its old
 * configuration until the scheduler happened to be rebuilt — the worker now
 * reads current configuration from the database on every run.
 */
export async function scheduleMonitor(
  monitorId: number,
  intervalSeconds: number
): Promise<void> {
  await monitorQueue.upsertJobScheduler(
    schedulerId(monitorId),
    { every: intervalSeconds * 1000 },
    {
      name: "check",
      data: { monitorId },
      opts: { removeOnComplete: true, removeOnFail: 100 },
    }
  );
}

export async function removeMonitorJob(monitorId: number): Promise<void> {
  const id = schedulerId(monitorId);

  await monitorQueue.removeJobScheduler(id);

  // Removing the scheduler stops new jobs being produced but leaves any
  // already-materialised delayed instance behind, which would fire once more
  // against a monitor that no longer exists.
  const delayed = await monitorQueue.getDelayed();

  for (const job of delayed) {
    if (job.id?.includes(id)) {
      await job.remove().catch((error) => {
        console.error(`Could not purge orphaned job for monitor ${monitorId}:`, error);
      });
    }
  }
}
