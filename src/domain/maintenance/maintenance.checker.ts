import { queryOne } from "../../core/db/client";

export async function isInMaintenance(monitorId: number): Promise<boolean> {
  const row = await queryOne<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM maintenance_windows
        WHERE monitor_id = $1 AND starts_at <= now() AND ends_at >= now()
     ) AS active`,
    [monitorId]
  );

  return row?.active ?? false;
}
