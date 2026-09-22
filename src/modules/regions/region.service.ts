import { execute, query, queryOne } from "../../core/db/client";

export interface Region {
  code: string;
  name: string;
  enabled: boolean;
  created_at: Date;
}

export const DEFAULT_REGION = "default";

export async function listRegions(enabledOnly = false): Promise<Region[]> {
  return query<Region>(
    `SELECT * FROM regions ${enabledOnly ? "WHERE enabled = true" : ""} ORDER BY code`
  );
}

export async function listEnabledRegionCodes(): Promise<string[]> {
  const rows = await query<{ code: string }>(
    `SELECT code FROM regions WHERE enabled = true ORDER BY code`
  );

  return rows.map((row) => row.code);
}

/**
 * Register the region a worker reports from.
 *
 * Workers announce themselves rather than being provisioned by hand: bringing
 * up a probe in a new location should be a deploy, not a deploy plus a
 * migration someone forgets.
 */
export async function ensureRegion(code: string, name?: string): Promise<void> {
  await execute(
    `INSERT INTO regions (code, name) VALUES ($1, $2)
     ON CONFLICT (code) DO NOTHING`,
    [code, name ?? code]
  );
}

/**
 * Which regions a monitor should be checked from.
 *
 * An empty `regions` array means "every enabled region", so adding a region
 * does not require rewriting every monitor. Regions that have since been
 * disabled are filtered out, and if that leaves nothing the monitor falls
 * back to every enabled region rather than silently stopping.
 */
export async function resolveMonitorRegions(
  assigned: string[],
  enabled?: string[]
): Promise<string[]> {
  const enabledCodes = enabled ?? (await listEnabledRegionCodes());

  if (enabledCodes.length === 0) return [DEFAULT_REGION];
  if (assigned.length === 0) return enabledCodes;

  const usable = assigned.filter((code) => enabledCodes.includes(code));

  return usable.length > 0 ? usable : enabledCodes;
}

export interface MonitorRegionState {
  monitor_id: number;
  region: string;
  status: "UP" | "DOWN" | "DEGRADED" | "UNCONFIRMED";
  consecutive_failures: number;
  consecutive_successes: number;
  last_checked_at: Date | null;
  last_root_cause: string | null;
  last_detail: string | null;
}

export async function getRegionState(
  monitorId: number,
  region: string
): Promise<MonitorRegionState | undefined> {
  return queryOne<MonitorRegionState>(
    `SELECT * FROM monitor_region_state WHERE monitor_id = $1 AND region = $2`,
    [monitorId, region]
  );
}

export async function saveRegionState(state: MonitorRegionState): Promise<void> {
  await execute(
    `INSERT INTO monitor_region_state
       (monitor_id, region, status, consecutive_failures, consecutive_successes,
        last_checked_at, last_root_cause, last_detail)
     VALUES ($1, $2, $3, $4, $5, now(), $6, $7)
     ON CONFLICT (monitor_id, region) DO UPDATE SET
       status                = EXCLUDED.status,
       consecutive_failures  = EXCLUDED.consecutive_failures,
       consecutive_successes = EXCLUDED.consecutive_successes,
       last_checked_at       = EXCLUDED.last_checked_at,
       last_root_cause       = EXCLUDED.last_root_cause,
       last_detail           = EXCLUDED.last_detail`,
    [
      state.monitor_id,
      state.region,
      state.status,
      state.consecutive_failures,
      state.consecutive_successes,
      state.last_root_cause,
      state.last_detail,
    ]
  );
}

/** Region states that count toward a quorum: assigned to the monitor and enabled. */
export async function getQuorumStates(
  monitorId: number,
  regions: string[]
): Promise<MonitorRegionState[]> {
  return query<MonitorRegionState>(
    `SELECT * FROM monitor_region_state
      WHERE monitor_id = $1 AND region = ANY($2::text[])`,
    [monitorId, regions]
  );
}

/** Drops state for regions a monitor is no longer checked from. */
export async function pruneRegionState(
  monitorId: number,
  keep: string[]
): Promise<void> {
  await execute(
    `DELETE FROM monitor_region_state
      WHERE monitor_id = $1 AND NOT (region = ANY($2::text[]))`,
    [monitorId, keep]
  );
}

export async function listRegionStatesForMonitor(
  monitorId: number
): Promise<MonitorRegionState[]> {
  return query<MonitorRegionState>(
    `SELECT * FROM monitor_region_state WHERE monitor_id = $1 ORDER BY region`,
    [monitorId]
  );
}
