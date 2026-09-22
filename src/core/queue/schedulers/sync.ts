import { listSchedulableMonitors } from "../../../modules/monitor/monitor.service";
import {
  listEnabledRegionCodes,
  pruneRegionState,
  resolveMonitorRegions,
} from "../../../modules/regions/region.service";
import { scheduleMonitor } from "./monitor.scheduler";

/**
 * Re-register a scheduler for every active monitor, in every region it runs
 * in, on boot.
 *
 * Schedulers live in Redis and monitors live in Postgres. If Redis is ever
 * flushed, replaced, or started empty, monitors simply stop being checked —
 * silently, because nothing errors. This makes Postgres the source of truth
 * and Redis a cache of it. upsert is idempotent, so a normal restart is a
 * no-op, and it is also how a newly added region picks up existing monitors.
 */
export async function syncMonitorSchedules(): Promise<void> {
  const monitors = await listSchedulableMonitors();
  const enabled = await listEnabledRegionCodes();

  let registered = 0;

  for (const monitor of monitors) {
    try {
      const regions = await resolveMonitorRegions(monitor.regions ?? [], enabled);

      await scheduleMonitor(monitor.id, monitor.interval_seconds, regions);

      // A region that was removed from the monitor, or disabled globally,
      // would otherwise leave a stale row voting in the quorum forever.
      await pruneRegionState(monitor.id, regions);

      registered += 1;
    } catch (error) {
      console.error(`Could not schedule monitor ${monitor.id}:`, error);
    }
  }

  console.log(
    `⏱  ${registered} monitor(s) scheduled across ${enabled.length} region(s)`
  );
}
