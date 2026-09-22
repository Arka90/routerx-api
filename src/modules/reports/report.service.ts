import { query } from "../../core/db/client";
import { buildWeeklyEmail, sendWeeklyReport } from "./report.formatter";

interface MonitorStatsRow {
  org_id: number;
  org_name: string;
  monitor_id: number;
  url: string;
  name: string | null;
  uptime_percentage: number;
  incident_count: number;
  downtime_seconds: number;
  longest_outage_seconds: number;
}

/**
 * One query for the whole report instead of four per monitor.
 *
 * Uptime is measured from incident duration rather than by counting UP probe
 * rows: probe counting silently conflated a monitor checked every 30 seconds
 * with one checked every 5 minutes, and broke entirely once old probe rows
 * started being pruned.
 */
async function weeklyStats(since: Date): Promise<MonitorStatsRow[]> {
  return query<MonitorStatsRow>(
    `WITH window_bounds AS (
       SELECT $1::timestamptz AS start_at, now() AS end_at
     ),
     per_incident AS (
       SELECT
         i.monitor_id,
         GREATEST(
           EXTRACT(EPOCH FROM (
             LEAST(COALESCE(i.resolved_at, w.end_at), w.end_at)
             - GREATEST(i.started_at, w.start_at)
           )), 0
         ) AS seconds
       FROM incidents i, window_bounds w
       WHERE i.started_at <= w.end_at
         AND COALESCE(i.resolved_at, w.end_at) >= w.start_at
     ),
     rolled_up AS (
       SELECT monitor_id,
              COUNT(*)::int AS incident_count,
              COALESCE(SUM(seconds), 0) AS downtime_seconds,
              COALESCE(MAX(seconds), 0) AS longest_outage_seconds
         FROM per_incident
        GROUP BY monitor_id
     )
     SELECT
       o.id AS org_id,
       o.name AS org_name,
       m.id AS monitor_id,
       m.url,
       m.name,
       GREATEST(0, LEAST(100,
         (1 - COALESCE(r.downtime_seconds, 0) / GREATEST(
            EXTRACT(EPOCH FROM (w.end_at - GREATEST(m.created_at, w.start_at))), 1
         )) * 100
       ))::float8 AS uptime_percentage,
       COALESCE(r.incident_count, 0) AS incident_count,
       COALESCE(r.downtime_seconds, 0)::float8 AS downtime_seconds,
       COALESCE(r.longest_outage_seconds, 0)::float8 AS longest_outage_seconds
     FROM monitors m
     JOIN organizations o ON o.id = m.org_id
     CROSS JOIN window_bounds w
     LEFT JOIN rolled_up r ON r.monitor_id = m.id
     ORDER BY o.id, m.created_at`,
    [since]
  );
}

export async function generateWeeklyReports(): Promise<void> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const stats = await weeklyStats(since);

  if (stats.length === 0) {
    console.log("No monitors to report on");
    return;
  }

  const byOrg = new Map<number, MonitorStatsRow[]>();

  for (const row of stats) {
    const existing = byOrg.get(row.org_id);
    if (existing) existing.push(row);
    else byOrg.set(row.org_id, [row]);
  }

  let sent = 0;

  for (const [orgId, rows] of byOrg) {
    const recipients = await query<{ email: string }>(
      `SELECT u.email::text AS email
         FROM org_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1`,
      [orgId]
    );

    if (recipients.length === 0) continue;

    const html = buildWeeklyEmail(
      rows[0].org_name,
      rows.map((row) => ({
        url: row.name ?? row.url,
        uptime: row.uptime_percentage,
        incidents: row.incident_count,
        downtime: row.downtime_seconds,
        longest: row.longest_outage_seconds,
      }))
    );

    try {
      await sendWeeklyReport(
        recipients.map((r) => r.email),
        html
      );
      sent += 1;
    } catch (error) {
      // One workspace's bad address must not stop everyone else's report.
      console.error(`Weekly report failed for org ${orgId}:`, error);
    }
  }

  console.log(`📊 Weekly reports sent to ${sent} workspace(s)`);
}
