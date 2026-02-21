import { db } from "../../core/db/client";
import { buildWeeklyEmail, sendWeeklyReport } from "./report.formatter";


interface MonitorRow {
  id: number;
  user_id: number;
  url: string;
}

interface UptimeStats {
  total: number;
  up: number;
}

interface IncidentCount {
  count: number;
}

interface DowntimeResult {
  downtime_seconds: number | null;
}

interface LongestOutageResult {
  longest: number | null;
}

export async function generateWeeklyReports() {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 7);

  const startISO = start.toISOString();
  const endISO = end.toISOString();

  // Grab every monitor with its owner email
  const monitors = db
    .prepare(
      `
      SELECT m.id, m.user_id, m.url, u.email
      FROM monitors m
      JOIN users u ON u.id = m.user_id
      `
    )
    .all() as (MonitorRow & { email: string })[];

  // Group monitors by user
  const byUser = new Map<
    string,
    { email: string; reports: ReturnType<typeof buildMonitorReport>[] }
  >();

  for (const mon of monitors) {
    const report = buildMonitorReport(mon.id, mon.url, startISO, endISO);

    if (!byUser.has(mon.email)) {
      byUser.set(mon.email, { email: mon.email, reports: [] });
    }
    byUser.get(mon.email)!.reports.push(report);
  }

  // Send one email per user
  for (const [email, userData] of byUser) {
    const html = buildWeeklyEmail(userData.reports);
    await sendWeeklyReport(email, html);
    console.log(`📧 Weekly report sent to ${email}`);
  }

  console.log(`📊 Weekly reports generated for ${byUser.size} user(s)`);
}

// ── per-monitor aggregation ────────────────────────────────

function buildMonitorReport(
  monitorId: number,
  url: string,
  startISO: string,
  endISO: string
) {
  // 1️⃣ Uptime %
  const stats = db
    .prepare(
      `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'UP' THEN 1 ELSE 0 END) as up
      FROM probe_results
      WHERE monitor_id = ?
        AND created_at BETWEEN ? AND ?
      `
    )
    .get(monitorId, startISO, endISO) as UptimeStats;

  const uptime =
    stats.total > 0 ? (stats.up / stats.total) * 100 : 100;

  // 2️⃣ Incident count
  const incidentRow = db
    .prepare(
      `
      SELECT COUNT(*) as count
      FROM incidents
      WHERE monitor_id = ?
        AND started_at BETWEEN ? AND ?
      `
    )
    .get(monitorId, startISO, endISO) as IncidentCount;

  // 3️⃣ Total downtime (seconds)
  const downtimeRow = db
    .prepare(
      `
      SELECT SUM(
        (JULIANDAY(resolved_at) - JULIANDAY(started_at)) * 86400
      ) as downtime_seconds
      FROM incidents
      WHERE monitor_id = ?
        AND resolved_at IS NOT NULL
        AND started_at BETWEEN ? AND ?
      `
    )
    .get(monitorId, startISO, endISO) as DowntimeResult;

  // 4️⃣ Longest outage (seconds)
  const longestRow = db
    .prepare(
      `
      SELECT MAX(
        (JULIANDAY(resolved_at) - JULIANDAY(started_at)) * 86400
      ) as longest
      FROM incidents
      WHERE monitor_id = ?
        AND resolved_at IS NOT NULL
        AND started_at BETWEEN ? AND ?
      `
    )
    .get(monitorId, startISO, endISO) as LongestOutageResult;

  return {
    url,
    uptime,
    incidents: incidentRow.count,
    downtime: downtimeRow.downtime_seconds ?? 0,
    longest: longestRow.longest ?? 0,
  };
}
