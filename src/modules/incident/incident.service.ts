import { execute, query, queryOne } from "../../core/db/client";

export interface Incident {
  id: number;
  monitor_id: number;
  started_at: Date;
  resolved_at: Date | null;
  duration_seconds: number | null;
  root_cause: string | null;
  failure_detail: string | null;
  affected_regions: string[];
  acknowledged_at: Date | null;
  acknowledged_by: number | null;
  last_notified_at: Date | null;
  notify_count: number;
  created_at: Date;
}

/**
 * Open an incident, or return null when one is already open.
 *
 * The "is one already open?" test lives in the ON CONFLICT clause rather than
 * in a preceding SELECT: two probes finishing at the same moment would both
 * pass a read-then-write check, and the partial unique index would turn the
 * loser into an unhandled 500 instead of a no-op.
 */
export async function openIncident(
  monitorId: number,
  rootCause: string | null,
  detail: string | null,
  affectedRegions: string[] = []
): Promise<Incident | null> {
  const rows = await query<Incident>(
    `INSERT INTO incidents
       (monitor_id, started_at, root_cause, failure_detail, affected_regions, last_notified_at)
     VALUES ($1, now(), $2, $3, $4, NULL)
     ON CONFLICT (monitor_id) WHERE resolved_at IS NULL DO NOTHING
     RETURNING *`,
    [monitorId, rootCause, detail, affectedRegions]
  );

  return rows[0] ?? null;
}

export async function resolveIncident(monitorId: number): Promise<Incident | null> {
  const rows = await query<Incident>(
    `UPDATE incidents
        SET resolved_at = now(),
            duration_seconds = EXTRACT(EPOCH FROM (now() - started_at))::int
      WHERE monitor_id = $1 AND resolved_at IS NULL
      RETURNING *`,
    [monitorId]
  );

  return rows[0] ?? null;
}

export async function getOpenIncident(monitorId: number): Promise<Incident | null> {
  const incident = await queryOne<Incident>(
    `SELECT * FROM incidents WHERE monitor_id = $1 AND resolved_at IS NULL`,
    [monitorId]
  );

  return incident ?? null;
}

export async function markNotified(incidentId: number): Promise<void> {
  await execute(
    `UPDATE incidents
        SET last_notified_at = now(), notify_count = notify_count + 1
      WHERE id = $1`,
    [incidentId]
  );
}

export async function listIncidents(monitorId: number, limit = 100): Promise<Incident[]> {
  return query<Incident>(
    `SELECT * FROM incidents WHERE monitor_id = $1 ORDER BY started_at DESC LIMIT $2`,
    [monitorId, limit]
  );
}

export interface OrgIncident extends Incident {
  monitor_url: string;
  monitor_name: string | null;
}

/**
 * Every incident in the organization in one query.
 *
 * The global incidents page used to issue one request per monitor and then
 * discard the monitors that had none — an N+1 over HTTP that got slower with
 * every monitor added.
 */
export async function listOrgIncidents(
  orgId: number,
  options: { limit?: number; openOnly?: boolean } = {}
): Promise<OrgIncident[]> {
  const limit = Math.min(500, options.limit ?? 100);

  return query<OrgIncident>(
    `SELECT i.*, m.url AS monitor_url, m.name AS monitor_name
       FROM incidents i
       JOIN monitors m ON m.id = i.monitor_id
      WHERE m.org_id = $1
        AND ($2::boolean = false OR i.resolved_at IS NULL)
      ORDER BY i.started_at DESC
      LIMIT $3`,
    [orgId, options.openOnly ?? false, limit]
  );
}

export async function acknowledgeIncident(
  orgId: number,
  incidentId: number,
  userId: number
): Promise<Incident | null> {
  const rows = await query<Incident>(
    `UPDATE incidents i
        SET acknowledged_at = now(), acknowledged_by = $3
       FROM monitors m
      WHERE i.monitor_id = m.id
        AND m.org_id = $1
        AND i.id = $2
        AND i.acknowledged_at IS NULL
      RETURNING i.*`,
    [orgId, incidentId, userId]
  );

  return rows[0] ?? null;
}

export interface UptimeResult {
  uptime_percentage: number;
  total_downtime_seconds: number;
  window_hours: number;
  observed_hours: number;
}

/**
 * Uptime over a rolling window, measured only across the time the monitor has
 * actually existed. Dividing by the full window regardless made the figure
 * meaningless for anything younger than it.
 */
export async function calculateUptime(
  monitorId: number,
  windowHours = 24
): Promise<UptimeResult> {
  const row = await queryOne<{
    downtime_seconds: number;
    observed_seconds: number;
  }>(
    `WITH bounds AS (
       SELECT GREATEST(now() - ($2 || ' hours')::interval, m.created_at) AS window_start,
              now() AS window_end
         FROM monitors m
        WHERE m.id = $1
     )
     SELECT
       COALESCE((
         SELECT SUM(
           EXTRACT(EPOCH FROM (
             LEAST(COALESCE(i.resolved_at, b.window_end), b.window_end)
             - GREATEST(i.started_at, b.window_start)
           ))
         )
         FROM incidents i, bounds b
        WHERE i.monitor_id = $1
          AND i.started_at <= b.window_end
          AND COALESCE(i.resolved_at, b.window_end) >= b.window_start
       ), 0)::float8 AS downtime_seconds,
       (SELECT EXTRACT(EPOCH FROM (b.window_end - b.window_start)) FROM bounds b)::float8
         AS observed_seconds`,
    [monitorId, windowHours]
  );

  if (!row) {
    return {
      uptime_percentage: 100,
      total_downtime_seconds: 0,
      window_hours: windowHours,
      observed_hours: 0,
    };
  }

  // A monitor created seconds ago would otherwise divide by ~0.
  const observed = Math.max(1, row.observed_seconds);
  const downtime = Math.min(Math.max(0, row.downtime_seconds), observed);

  return {
    uptime_percentage: Number(((1 - downtime / observed) * 100).toFixed(4)),
    total_downtime_seconds: Math.round(downtime),
    window_hours: windowHours,
    observed_hours: Number((observed / 3600).toFixed(2)),
  };
}

// ---------------------------------------------------------------
// Incident updates
// ---------------------------------------------------------------

export type IncidentUpdateStatus =
  | "investigating"
  | "identified"
  | "monitoring"
  | "resolved";

export interface IncidentUpdate {
  id: number;
  incident_id: number;
  author_id: number | null;
  author_email: string | null;
  status: IncidentUpdateStatus;
  body: string;
  is_public: boolean;
  created_at: Date;
}

/** Incidents belong to monitors; monitors belong to a workspace. */
export async function incidentBelongsToOrg(
  orgId: number,
  incidentId: number
): Promise<boolean> {
  const row = await queryOne<{ id: number }>(
    `SELECT i.id
       FROM incidents i
       JOIN monitors m ON m.id = i.monitor_id
      WHERE i.id = $1 AND m.org_id = $2`,
    [incidentId, orgId]
  );

  return Boolean(row);
}

export async function listIncidentUpdates(
  incidentId: number
): Promise<IncidentUpdate[]> {
  return query<IncidentUpdate>(
    `SELECT u.*, au.email::text AS author_email
       FROM incident_updates u
       LEFT JOIN users au ON au.id = u.author_id
      WHERE u.incident_id = $1
      ORDER BY u.created_at ASC`,
    [incidentId]
  );
}

export async function addIncidentUpdate(
  incidentId: number,
  authorId: number,
  input: { status: IncidentUpdateStatus; body: string; is_public: boolean }
): Promise<IncidentUpdate> {
  const row = await queryOne<IncidentUpdate>(
    `INSERT INTO incident_updates (incident_id, author_id, status, body, is_public)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [incidentId, authorId, input.status, input.body.trim(), input.is_public]
  );

  return row!;
}
