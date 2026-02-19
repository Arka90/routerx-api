import { db } from "../../core/db/client";

export interface Incident {
  id: number;
  monitor_id: number;
  started_at: string;
  resolved_at: string | null;
  duration_seconds: number | null;
  created_at: string;
}

/**
 * Open a new incident when a monitor is confirmed DOWN.
 * If there's already an open incident for this monitor, skip.
 */
export function openIncident(monitorId: number): Incident | null {
  const existing = db
    .prepare(
      `SELECT id FROM incidents WHERE monitor_id = ? AND resolved_at IS NULL`
    )
    .get(monitorId) as any;

  if (existing) return null; // already tracking

  const now = new Date().toISOString();

  const result = db
    .prepare(
      `INSERT INTO incidents (monitor_id, started_at) VALUES (?, ?)`
    )
    .run(monitorId, now);

  return {
    id: Number(result.lastInsertRowid),
    monitor_id: monitorId,
    started_at: now,
    resolved_at: null,
    duration_seconds: null,
    created_at: now,
  };
}

/**
 * Resolve the open incident for a monitor when it recovers.
 * Sets resolved_at and computes duration_seconds.
 */
export function resolveIncident(monitorId: number): Incident | null {
  const open = db
    .prepare(
      `SELECT * FROM incidents WHERE monitor_id = ? AND resolved_at IS NULL`
    )
    .get(monitorId) as Incident | undefined;

  if (!open) return null;

  const now = new Date();
  const startedAt = new Date(open.started_at);
  const durationSeconds = Math.round(
    (now.getTime() - startedAt.getTime()) / 1000
  );

  db.prepare(
    `UPDATE incidents SET resolved_at = ?, duration_seconds = ? WHERE id = ?`
  ).run(now.toISOString(), durationSeconds, open.id);

  return {
    ...open,
    resolved_at: now.toISOString(),
    duration_seconds: durationSeconds,
  };
}

/**
 * Get the currently-open (unresolved) incident for a monitor.
 */
export function getOpenIncident(monitorId: number): Incident | null {
  return (
    (db
      .prepare(
        `SELECT * FROM incidents WHERE monitor_id = ? AND resolved_at IS NULL`
      )
      .get(monitorId) as Incident | undefined) ?? null
  );
}

/**
 * Get all incidents for a monitor, newest first.
 */
export function getIncidentsByMonitor(monitorId: number): Incident[] {
  return db
    .prepare(
      `SELECT * FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC`
    )
    .all(monitorId) as Incident[];
}

/**
 * Calculate uptime percentage over a rolling time window.
 *
 * Formula:  uptime% = (1 − totalDowntime / windowSeconds) × 100
 *
 * Handles partially-overlapping and still-open incidents.
 */
export function calculateUptime(
  monitorId: number,
  windowHours: number = 24
): { uptime_percentage: number; total_downtime_seconds: number; window_hours: number } {
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowHours * 3600 * 1000);
  const windowSeconds = windowHours * 3600;

  // Fetch incidents that overlap the window:
  //   started_at < now  AND  (resolved_at > windowStart  OR  resolved_at IS NULL)
  const incidents = db
    .prepare(
      `
      SELECT started_at, resolved_at
      FROM incidents
      WHERE monitor_id = ?
        AND started_at <= ?
        AND (resolved_at >= ? OR resolved_at IS NULL)
      `
    )
    .all(monitorId, now.toISOString(), windowStart.toISOString()) as {
    started_at: string;
    resolved_at: string | null;
  }[];

  let totalDowntime = 0;

  for (const inc of incidents) {
    const start = new Date(
      Math.max(new Date(inc.started_at).getTime(), windowStart.getTime())
    );
    const end = inc.resolved_at
      ? new Date(Math.min(new Date(inc.resolved_at).getTime(), now.getTime()))
      : now;

    totalDowntime += (end.getTime() - start.getTime()) / 1000;
  }

  totalDowntime = Math.min(totalDowntime, windowSeconds); // clamp

  const uptimePercentage = parseFloat(
    ((1 - totalDowntime / windowSeconds) * 100).toFixed(4)
  );

  return {
    uptime_percentage: uptimePercentage,
    total_downtime_seconds: Math.round(totalDowntime),
    window_hours: windowHours,
  };
}
