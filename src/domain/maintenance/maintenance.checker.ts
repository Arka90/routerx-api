import { db } from "../../core/db/client";

export function isInMaintenance(monitorId: number): boolean {
  const now = new Date().toISOString();

  const row = db.prepare(`
    SELECT 1
    FROM maintenance_windows
    WHERE monitor_id = ?
      AND starts_at <= ?
      AND ends_at >= ?
    LIMIT 1
  `).get(monitorId, now, now);

  return !!row;
}