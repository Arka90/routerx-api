import { listSchedulableMonitors } from "../../../modules/monitor/monitor.service";
import { scheduleMonitor } from "./monitor.scheduler";

/**
 * Re-register a scheduler for every active monitor on boot.
 *
 * Schedulers live in Redis, and monitors live in Postgres. If Redis is ever
 * flushed, replaced, or started empty, the monitors simply stop being
 * checked — silently, because nothing errors. This makes Postgres the source
 * of truth and Redis a cache of it. upsert is idempotent, so a normal restart
 * is a no-op.
 */
export async function syncMonitorSchedules(): Promise<void> {
  const monitors = await listSchedulableMonitors();

  let registered = 0;

  for (const monitor of monitors) {
    try {
      await scheduleMonitor(monitor.id, monitor.interval_seconds);
      registered += 1;
    } catch (error) {
      console.error(`Could not schedule monitor ${monitor.id}:`, error);
    }
  }

  console.log(`⏱  ${registered} monitor schedule(s) registered`);
}
