import { monitorQueue } from "../monitor.queue";
import { resolveMonitorRegions } from "../../../modules/regions/region.service";

function schedulerId(monitorId: number, region: string): string {
  return `monitor:${monitorId}:${region}`;
}

/**
 * Register a repeating check per region.
 *
 * The job carries only the monitor id and region. It used to carry the url and
 * interval too, which meant an edited monitor kept being checked against its
 * old configuration until the scheduler happened to be rebuilt.
 */
export async function scheduleMonitor(
  monitorId: number,
  intervalSeconds: number,
  regions?: string[]
): Promise<void> {
  const targets = regions ?? (await resolveMonitorRegions([]));

  for (const region of targets) {
    await monitorQueue(region).upsertJobScheduler(
      schedulerId(monitorId, region),
      { every: intervalSeconds * 1000 },
      {
        name: "check",
        data: { monitorId, region },
        opts: { removeOnComplete: true, removeOnFail: 100 },
      }
    );
  }
}

/**
 * Remove a monitor's schedulers.
 *
 * `regions` is optional because a monitor that has just been deleted can no
 * longer say which regions it ran in — passing every known region is how the
 * caller makes sure nothing is left behind.
 */
export async function removeMonitorJob(
  monitorId: number,
  regions?: string[]
): Promise<void> {
  const targets = regions ?? (await resolveMonitorRegions([]));

  for (const region of targets) {
    const id = schedulerId(monitorId, region);
    const queue = monitorQueue(region);

    await queue.removeJobScheduler(id);

    // Removing the scheduler stops new jobs being produced but leaves any
    // already-materialised delayed instance behind, which would fire once
    // more against a monitor that no longer exists.
    const delayed = await queue.getDelayed();

    for (const job of delayed) {
      if (job.id?.includes(id)) {
        await job.remove().catch((error) => {
          console.error(`Could not purge orphaned job for monitor ${monitorId}:`, error);
        });
      }
    }
  }
}
