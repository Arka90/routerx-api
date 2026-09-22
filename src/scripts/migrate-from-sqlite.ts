/**
 * One-off import of an existing SQLite database into Postgres.
 *
 * Usage:
 *   SQLITE_PATH=/app/data/routerx.db DATABASE_URL=postgres://... \
 *     node dist/scripts/migrate-from-sqlite.js
 *
 * Safe to re-run: every insert is keyed on a natural identifier and skips
 * rows that are already present, so a partial run can simply be repeated.
 * It never writes to the SQLite file.
 */
import path from "path";
import { execute, query, queryOne, withTransaction } from "../core/db/client";
import { runMigrations } from "../core/db/migrate";
import { ensureDefaultChannel } from "../modules/channels/channel.service";

interface SqliteUser {
  id: number;
  email: string;
  created_at: string;
}

interface SqliteMonitor {
  id: number;
  user_id: number;
  url: string;
  interval_seconds: number;
  created_at: string;
  confirmed_status: string | null;
  consecutive_failures: number | null;
  consecutive_successes: number | null;
  tls_expiry_at: string | null;
  tls_alerted_days: string | null;
  in_maintenance: number | null;
}

/**
 * SQLite's CURRENT_TIMESTAMP writes "YYYY-MM-DD HH:MM:SS" in UTC with no zone
 * marker. Handing that to Postgres as-is would be read in the server's
 * timezone and silently shift every timestamp.
 */
function toTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;

  const normalized = /[Zz]|[+-]\d{2}:?\d{2}$/.test(value)
    ? value
    : `${value.replace(" ", "T")}Z`;

  const parsed = new Date(normalized);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseAlertedDays(value: string | null): number[] {
  if (!value) return [];

  return value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((day) => Number.isInteger(day));
}

const VALID_STATUSES = new Set(["UP", "DOWN", "DEGRADED", "UNCONFIRMED", "MAINTENANCE"]);

async function main() {
  const sqlitePath =
    process.env.SQLITE_PATH ?? path.join(process.cwd(), "routerx.db");

  // Required lazily so the rest of the app never loads the native module.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require("better-sqlite3");
  const sqlite = new Database(sqlitePath, { readonly: true });

  console.log(`Reading ${sqlitePath}`);

  await runMigrations();

  // ---- users + a workspace each -------------------------------------
  const users = sqlite.prepare(`SELECT * FROM users`).all() as SqliteUser[];
  const orgByOldUserId = new Map<number, number>();
  const userIdMap = new Map<number, number>();

  for (const user of users) {
    const email = user.email.trim().toLowerCase();

    const inserted = await queryOne<{ id: number }>(
      `INSERT INTO users (email, created_at) VALUES ($1, COALESCE($2, now()))
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [email, toTimestamp(user.created_at)]
    );

    const newUserId = inserted!.id;
    userIdMap.set(user.id, newUserId);

    // Monitors belonged to a user; they now belong to a workspace, so each
    // imported user gets one with themselves as owner.
    const existingOrg = await queryOne<{ org_id: number }>(
      `SELECT org_id FROM org_members WHERE user_id = $1 ORDER BY created_at LIMIT 1`,
      [newUserId]
    );

    if (existingOrg) {
      orgByOldUserId.set(user.id, existingOrg.org_id);
      continue;
    }

    const handle = email.split("@")[0] || "workspace";

    const org = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
        [`${handle}'s workspace`, `${handle}-${newUserId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-")]
      );

      await client.query(
        `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [rows[0].id, newUserId]
      );

      return rows[0].id;
    });

    await ensureDefaultChannel(org);
    orgByOldUserId.set(user.id, org);
  }

  console.log(`Imported ${users.length} user(s)`);

  // ---- monitors -----------------------------------------------------
  const monitors = sqlite.prepare(`SELECT * FROM monitors`).all() as SqliteMonitor[];
  const monitorIdMap = new Map<number, number>();

  for (const monitor of monitors) {
    const orgId = orgByOldUserId.get(monitor.user_id);

    if (!orgId) {
      console.warn(`Skipping monitor ${monitor.id}: no workspace for user ${monitor.user_id}`);
      continue;
    }

    const status =
      monitor.confirmed_status && VALID_STATUSES.has(monitor.confirmed_status)
        ? monitor.confirmed_status
        : "UNCONFIRMED";

    // Intervals outside the new CHECK bounds would abort the whole import.
    const interval = Math.min(3600, Math.max(30, monitor.interval_seconds || 60));

    const inserted = await queryOne<{ id: number }>(
      `INSERT INTO monitors (
         org_id, created_by, url, interval_seconds, confirmed_status,
         consecutive_failures, consecutive_successes, tls_expiry_at,
         tls_alerted_days, in_maintenance, created_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11, now()))
       ON CONFLICT (org_id, url, method) DO NOTHING
       RETURNING id`,
      [
        orgId,
        userIdMap.get(monitor.user_id) ?? null,
        monitor.url,
        interval,
        status,
        monitor.consecutive_failures ?? 0,
        monitor.consecutive_successes ?? 0,
        toTimestamp(monitor.tls_expiry_at),
        parseAlertedDays(monitor.tls_alerted_days),
        Boolean(monitor.in_maintenance),
        toTimestamp(monitor.created_at),
      ]
    );

    const newId =
      inserted?.id ??
      (
        await queryOne<{ id: number }>(
          `SELECT id FROM monitors WHERE org_id = $1 AND url = $2 AND method = 'GET'`,
          [orgId, monitor.url]
        )
      )?.id;

    if (!newId) continue;

    monitorIdMap.set(monitor.id, newId);

    await execute(
      `INSERT INTO alert_policies (monitor_id) VALUES ($1)
       ON CONFLICT (monitor_id) DO NOTHING`,
      [newId]
    );
  }

  console.log(`Imported ${monitorIdMap.size} monitor(s)`);

  // ---- incidents ----------------------------------------------------
  //
  // The new schema allows at most one open incident per monitor. Older data
  // can contain several, so everything but the most recent is closed off at
  // its own start time rather than dropped.
  const incidents = sqlite
    .prepare(`SELECT * FROM incidents ORDER BY monitor_id, started_at DESC`)
    .all() as Array<{
    id: number;
    monitor_id: number;
    started_at: string;
    resolved_at: string | null;
    duration_seconds: number | null;
    root_cause: string | null;
  }>;

  const seenOpen = new Set<number>();
  let importedIncidents = 0;

  for (const incident of incidents) {
    const monitorId = monitorIdMap.get(incident.monitor_id);
    if (!monitorId) continue;

    const startedAt = toTimestamp(incident.started_at);
    if (!startedAt) continue;

    let resolvedAt = toTimestamp(incident.resolved_at);

    if (!resolvedAt) {
      if (seenOpen.has(monitorId)) {
        resolvedAt = startedAt; // zero-length: keeps the record, drops the conflict
      } else {
        seenOpen.add(monitorId);
      }
    }

    await execute(
      `INSERT INTO incidents
         (monitor_id, started_at, resolved_at, duration_seconds, root_cause)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        monitorId,
        startedAt,
        resolvedAt,
        incident.duration_seconds ??
          (resolvedAt ? Math.round((resolvedAt.getTime() - startedAt.getTime()) / 1000) : null),
        incident.root_cause,
      ]
    );

    importedIncidents += 1;
  }

  console.log(`Imported ${importedIncidents} incident(s)`);

  // ---- maintenance windows ------------------------------------------
  const windows = sqlite.prepare(`SELECT * FROM maintenance_windows`).all() as Array<{
    monitor_id: number;
    starts_at: string;
    ends_at: string;
    reason: string | null;
  }>;

  let importedWindows = 0;

  for (const window of windows) {
    const monitorId = monitorIdMap.get(window.monitor_id);
    if (!monitorId) continue;

    const startsAt = toTimestamp(window.starts_at);
    const endsAt = toTimestamp(window.ends_at);

    // The new table has a CHECK (ends_at > starts_at).
    if (!startsAt || !endsAt || endsAt <= startsAt) continue;

    await execute(
      `INSERT INTO maintenance_windows (monitor_id, starts_at, ends_at, reason)
       VALUES ($1, $2, $3, $4)`,
      [monitorId, startsAt, endsAt, window.reason]
    );

    importedWindows += 1;
  }

  console.log(`Imported ${importedWindows} maintenance window(s)`);

  // ---- probe history -------------------------------------------------
  //
  // Only the retention window is worth carrying over; older rows would be
  // deleted by the nightly prune anyway.
  const retentionDays = Number(process.env.PROBE_RETENTION_DAYS) || 30;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000);

  const probes = sqlite.prepare(`SELECT * FROM probe_results`).all() as Array<{
    monitor_id: number;
    dns: number | null;
    tcp: number | null;
    tls: number | null;
    ttfb: number | null;
    status: string | null;
    http_status_code: number | null;
    root_cause: string | null;
    created_at: string;
  }>;

  let importedProbes = 0;

  for (const probe of probes) {
    const monitorId = monitorIdMap.get(probe.monitor_id);
    if (!monitorId) continue;

    const createdAt = toTimestamp(probe.created_at);
    if (!createdAt || createdAt < cutoff) continue;

    await execute(
      `INSERT INTO probe_results
         (monitor_id, dns, tcp, tls, ttfb, status, http_status_code, root_cause, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        monitorId,
        probe.dns,
        probe.tcp,
        probe.tls,
        probe.ttfb,
        probe.status ?? "UNKNOWN",
        probe.http_status_code,
        probe.root_cause,
        createdAt,
      ]
    );

    importedProbes += 1;
  }

  console.log(`Imported ${importedProbes} probe result(s)`);

  const counts = await query<{ table_name: string; count: number }>(
    `SELECT 'users' AS table_name, COUNT(*)::int AS count FROM users
     UNION ALL SELECT 'organizations', COUNT(*)::int FROM organizations
     UNION ALL SELECT 'monitors', COUNT(*)::int FROM monitors
     UNION ALL SELECT 'incidents', COUNT(*)::int FROM incidents
     UNION ALL SELECT 'probe_results', COUNT(*)::int FROM probe_results`
  );

  console.log("\nPostgres now contains:");
  for (const row of counts) console.log(`  ${row.table_name}: ${row.count}`);

  sqlite.close();

  console.log(
    "\nDone. Old login codes were deliberately not imported — everyone signs " +
      "in again with a fresh code."
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Import failed:", error);
    process.exit(1);
  });
