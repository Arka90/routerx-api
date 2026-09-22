import { query, queryOne } from "../../core/db/client";

export interface PublicComponent {
  name: string;
  status: "operational" | "degraded" | "outage" | "maintenance" | "unknown";
  uptime_percentage: number | null;
  /** Oldest first, 90 entries. null means the monitor did not exist yet. */
  history: Array<{ date: string; uptime: number | null }>;
}

export interface PublicIncidentUpdate {
  status: string;
  body: string;
  created_at: Date;
}

export interface PublicIncident {
  id: number;
  component: string;
  started_at: Date;
  resolved_at: Date | null;
  updates: PublicIncidentUpdate[];
}

export interface PublicStatusPage {
  name: string;
  headline: string | null;
  about: string | null;
  support_url: string | null;
  show_uptime: boolean;
  overall: "operational" | "degraded" | "outage" | "maintenance";
  components: PublicComponent[];
  active_incidents: PublicIncident[];
  recent_incidents: PublicIncident[];
}

const HISTORY_DAYS = 90;

function componentStatus(
  confirmed: string,
  paused: boolean,
  inMaintenance: boolean
): PublicComponent["status"] {
  if (paused) return "unknown";
  if (inMaintenance) return "maintenance";
  if (confirmed === "DOWN") return "outage";
  if (confirmed === "DEGRADED") return "degraded";
  if (confirmed === "UP") return "operational";
  return "unknown";
}

interface DayRow {
  monitor_id: number;
  day: string;
  observed_seconds: number;
  downtime_seconds: number;
}

/**
 * Daily uptime for every component in one query.
 *
 * Computed from incident overlap rather than by counting probe rows: probe
 * counting conflates a 30-second interval with a 5-minute one, and stops
 * working entirely once old probes are pruned. `observed_seconds` is clamped
 * to the monitor's age so a component added yesterday shows 89 blank days
 * rather than 89 days of fictional downtime.
 */
async function dailyHistory(monitorIds: number[]): Promise<Map<number, DayRow[]>> {
  if (monitorIds.length === 0) return new Map();

  const rows = await query<DayRow>(
    `WITH bounds AS (
       SELECT generate_series(
         date_trunc('day', now()) - ($2::int - 1) * interval '1 day',
         date_trunc('day', now()),
         interval '1 day'
       ) AS day_start
     )
     SELECT
       m.id AS monitor_id,
       to_char(b.day_start, 'YYYY-MM-DD') AS day,
       GREATEST(0, EXTRACT(EPOCH FROM (
         LEAST(b.day_start + interval '1 day', now())
         - GREATEST(b.day_start, m.created_at)
       )))::float8 AS observed_seconds,
       COALESCE((
         SELECT SUM(GREATEST(0, EXTRACT(EPOCH FROM (
           LEAST(COALESCE(i.resolved_at, now()), b.day_start + interval '1 day', now())
           - GREATEST(i.started_at, b.day_start, m.created_at)
         ))))
         FROM incidents i
         WHERE i.monitor_id = m.id
           AND i.started_at < b.day_start + interval '1 day'
           AND COALESCE(i.resolved_at, now()) > b.day_start
       ), 0)::float8 AS downtime_seconds
     FROM bounds b
     CROSS JOIN monitors m
     WHERE m.id = ANY($1::bigint[])
     ORDER BY m.id, b.day_start`,
    [monitorIds, HISTORY_DAYS]
  );

  const byMonitor = new Map<number, DayRow[]>();

  for (const row of rows) {
    const existing = byMonitor.get(row.monitor_id);
    if (existing) existing.push(row);
    else byMonitor.set(row.monitor_id, [row]);
  }

  return byMonitor;
}

async function incidentsFor(
  monitorIds: number[],
  names: Map<number, string>,
  options: { openOnly: boolean; limit: number }
): Promise<PublicIncident[]> {
  if (monitorIds.length === 0) return [];

  const incidents = await query<{
    id: number;
    monitor_id: number;
    started_at: Date;
    resolved_at: Date | null;
  }>(
    `SELECT id, monitor_id, started_at, resolved_at
       FROM incidents
      WHERE monitor_id = ANY($1::bigint[])
        AND ($2::boolean = false OR resolved_at IS NULL)
        AND started_at > now() - interval '90 days'
      ORDER BY started_at DESC
      LIMIT $3`,
    [monitorIds, options.openOnly, options.limit]
  );

  if (incidents.length === 0) return [];

  // Only updates explicitly marked public. An internal note stays internal.
  const updates = await query<{
    incident_id: number;
    status: string;
    body: string;
    created_at: Date;
  }>(
    `SELECT incident_id, status, body, created_at
       FROM incident_updates
      WHERE incident_id = ANY($1::bigint[]) AND is_public = true
      ORDER BY created_at ASC`,
    [incidents.map((incident) => incident.id)]
  );

  return incidents.map((incident) => ({
    id: incident.id,
    component: names.get(incident.monitor_id) ?? "Service",
    started_at: incident.started_at,
    resolved_at: incident.resolved_at,
    updates: updates
      .filter((update) => update.incident_id === incident.id)
      .map(({ status, body, created_at }) => ({ status, body, created_at })),
  }));
}

/**
 * Everything a published status page shows, for an anonymous visitor.
 *
 * Deliberately returns display names only — never the monitor's URL, which
 * usually points at an internal health-check path nobody outside should be
 * handed.
 */
export async function buildPublicStatusPage(
  slug: string
): Promise<PublicStatusPage | null> {
  const page = await queryOne<{
    id: number;
    name: string;
    headline: string | null;
    about: string | null;
    support_url: string | null;
    show_uptime: boolean;
  }>(
    `SELECT id, name, headline, about, support_url, show_uptime
       FROM status_pages
      WHERE slug = $1 AND published = true`,
    [slug]
  );

  if (!page) return null;

  const components = await query<{
    monitor_id: number;
    display_name: string;
    confirmed_status: string;
    paused: boolean;
    in_maintenance: boolean;
  }>(
    `SELECT spm.monitor_id, spm.display_name,
            m.confirmed_status, m.paused, m.in_maintenance
       FROM status_page_monitors spm
       JOIN monitors m ON m.id = spm.monitor_id
      WHERE spm.status_page_id = $1
      ORDER BY spm.position, spm.display_name`,
    [page.id]
  );

  const monitorIds = components.map((component) => component.monitor_id);
  const names = new Map(
    components.map((component) => [component.monitor_id, component.display_name])
  );

  const history = page.show_uptime ? await dailyHistory(monitorIds) : new Map();

  const publicComponents: PublicComponent[] = components.map((component) => {
    const days = history.get(component.monitor_id) ?? [];

    let observed = 0;
    let downtime = 0;

    const dayHistory = days.map((day: DayRow) => {
      observed += day.observed_seconds;
      downtime += day.downtime_seconds;

      if (day.observed_seconds <= 0) return { date: day.day, uptime: null };

      const ratio = 1 - Math.min(day.downtime_seconds, day.observed_seconds) / day.observed_seconds;

      return { date: day.day, uptime: Number((ratio * 100).toFixed(3)) };
    });

    return {
      name: component.display_name,
      status: componentStatus(
        component.confirmed_status,
        component.paused,
        component.in_maintenance
      ),
      uptime_percentage:
        observed > 0
          ? Number(((1 - Math.min(downtime, observed) / observed) * 100).toFixed(3))
          : null,
      history: dayHistory,
    };
  });

  const statuses = publicComponents.map((component) => component.status);

  const overall: PublicStatusPage["overall"] = statuses.includes("outage")
    ? "outage"
    : statuses.includes("degraded")
    ? "degraded"
    : statuses.includes("maintenance")
    ? "maintenance"
    : "operational";

  return {
    name: page.name,
    headline: page.headline,
    about: page.about,
    support_url: page.support_url,
    show_uptime: page.show_uptime,
    overall,
    components: publicComponents,
    active_incidents: await incidentsFor(monitorIds, names, {
      openOnly: true,
      limit: 20,
    }),
    recent_incidents: await incidentsFor(monitorIds, names, {
      openOnly: false,
      limit: 20,
    }),
  };
}
