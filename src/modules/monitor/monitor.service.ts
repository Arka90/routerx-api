import { execute, query, queryOne, withTransaction } from "../../core/db/client";
import {
  DEFAULT_POLICY,
  type AlertPolicy,
  type AlertPolicyInput,
  type CreateMonitorInput,
  type Monitor,
  type MonitorWithPolicy,
  type UpdateMonitorInput,
} from "./monitor.types";

export class MonitorExistsError extends Error {}
export class MonitorNotFoundError extends Error {}

const MONITOR_COLUMNS = `
  id, org_id, created_by, name, url, method, request_headers, request_body,
  expected_status_codes, assertion_type, assertion_value, timeout_ms,
  follow_redirects, interval_seconds, paused, confirmed_status,
  consecutive_failures, consecutive_successes, tls_expiry_at,
  tls_alerted_days, in_maintenance, created_at, updated_at
`;

export async function createMonitor(
  orgId: number,
  userId: number,
  input: CreateMonitorInput
): Promise<Monitor> {
  const existing = await queryOne<{ id: number }>(
    `SELECT id FROM monitors WHERE org_id = $1 AND url = $2 AND method = $3`,
    [orgId, input.url, input.method ?? "GET"]
  );

  if (existing) {
    throw new MonitorExistsError("This workspace already monitors that URL");
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query<Monitor>(
      `INSERT INTO monitors (
         org_id, created_by, name, url, method, request_headers, request_body,
         expected_status_codes, assertion_type, assertion_value, timeout_ms,
         follow_redirects, interval_seconds, paused
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING ${MONITOR_COLUMNS}`,
      [
        orgId,
        userId,
        input.name ?? null,
        input.url,
        input.method ?? "GET",
        JSON.stringify(input.request_headers ?? {}),
        input.request_body ?? null,
        input.expected_status_codes ?? [],
        input.assertion_type ?? "none",
        input.assertion_value ?? null,
        input.timeout_ms ?? 10_000,
        input.follow_redirects ?? true,
        input.interval_seconds ?? 60,
        input.paused ?? false,
      ]
    );

    const monitor = rows[0];

    // Every monitor gets a policy row, so the worker never has to reason
    // about a missing one.
    await client.query(
      `INSERT INTO alert_policies (monitor_id) VALUES ($1)`,
      [monitor.id]
    );

    return monitor;
  });
}

export async function listMonitors(orgId: number): Promise<Monitor[]> {
  return query<Monitor>(
    `SELECT ${MONITOR_COLUMNS} FROM monitors WHERE org_id = $1 ORDER BY created_at DESC`,
    [orgId]
  );
}

export async function getMonitor(
  orgId: number,
  monitorId: number
): Promise<Monitor | undefined> {
  return queryOne<Monitor>(
    `SELECT ${MONITOR_COLUMNS} FROM monitors WHERE id = $1 AND org_id = $2`,
    [monitorId, orgId]
  );
}

/** Used by the worker, which has a monitor id but no organization context. */
export async function getMonitorForCheck(
  monitorId: number
): Promise<MonitorWithPolicy | undefined> {
  const monitor = await queryOne<Monitor>(
    `SELECT ${MONITOR_COLUMNS} FROM monitors WHERE id = $1`,
    [monitorId]
  );

  if (!monitor) return undefined;

  const policy =
    (await queryOne<AlertPolicy>(
      `SELECT * FROM alert_policies WHERE monitor_id = $1`,
      [monitorId]
    )) ?? { monitor_id: monitorId, ...DEFAULT_POLICY };

  const channels = await query<{ channel_id: number }>(
    `SELECT channel_id FROM monitor_channels WHERE monitor_id = $1`,
    [monitorId]
  );

  return { ...monitor, policy, channel_ids: channels.map((row) => row.channel_id) };
}

const UPDATABLE: Array<keyof UpdateMonitorInput> = [
  "name",
  "url",
  "method",
  "request_body",
  "expected_status_codes",
  "assertion_type",
  "assertion_value",
  "timeout_ms",
  "follow_redirects",
  "interval_seconds",
  "paused",
];

export async function updateMonitor(
  orgId: number,
  monitorId: number,
  input: UpdateMonitorInput
): Promise<Monitor> {
  const assignments: string[] = [];
  const params: unknown[] = [];

  for (const field of UPDATABLE) {
    if (input[field] === undefined) continue;
    params.push(input[field]);
    assignments.push(`${field} = $${params.length}`);
  }

  // jsonb needs an explicit cast that the generic loop above cannot give it.
  if (input.request_headers !== undefined) {
    params.push(JSON.stringify(input.request_headers));
    assignments.push(`request_headers = $${params.length}::jsonb`);
  }

  if (assignments.length === 0) {
    const current = await getMonitor(orgId, monitorId);
    if (!current) throw new MonitorNotFoundError("Monitor not found");
    return current;
  }

  assignments.push("updated_at = now()");

  params.push(monitorId, orgId);

  const rows = await query<Monitor>(
    `UPDATE monitors SET ${assignments.join(", ")}
      WHERE id = $${params.length - 1} AND org_id = $${params.length}
      RETURNING ${MONITOR_COLUMNS}`,
    params
  );

  if (rows.length === 0) throw new MonitorNotFoundError("Monitor not found");

  return rows[0];
}

export async function deleteMonitor(orgId: number, monitorId: number): Promise<boolean> {
  const removed = await execute(
    `DELETE FROM monitors WHERE id = $1 AND org_id = $2`,
    [monitorId, orgId]
  );

  if (removed === 0) throw new MonitorNotFoundError("Monitor not found");

  return true;
}

export async function getProbeResults(monitorId: number, limit = 100) {
  const rows = await query<{
    id: number;
    dns: number | null;
    tcp: number | null;
    tls: number | null;
    ttfb: number | null;
    status: string;
    http_status_code: number | null;
    root_cause: string | null;
    failure_detail: string | null;
    created_at: Date;
  }>(
    `SELECT id, dns, tcp, tls, ttfb, status, http_status_code, root_cause,
            failure_detail, created_at
       FROM probe_results
      WHERE monitor_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [monitorId, limit]
  );

  // Chronological for charting.
  return rows.reverse().map((row) => ({
    id: row.id,
    timestamp: row.created_at,
    dns: row.dns,
    tcp: row.tcp,
    tls: row.tls,
    ttfb: row.ttfb,
    status: row.status,
    http_status_code: row.http_status_code,
    root_cause: row.root_cause,
    failure_detail: row.failure_detail,
    responseTime: row.ttfb ?? row.tls ?? row.tcp ?? row.dns ?? 0,
  }));
}

// ---------------------------------------------------------------
// Alert policy
// ---------------------------------------------------------------

export async function getPolicy(monitorId: number): Promise<AlertPolicy> {
  const policy = await queryOne<AlertPolicy>(
    `SELECT * FROM alert_policies WHERE monitor_id = $1`,
    [monitorId]
  );

  return policy ?? { monitor_id: monitorId, ...DEFAULT_POLICY };
}

export async function updatePolicy(
  monitorId: number,
  input: AlertPolicyInput
): Promise<AlertPolicy> {
  const assignments: string[] = [];
  const params: unknown[] = [monitorId];

  const fields: Array<[keyof AlertPolicyInput, string]> = [
    ["failure_threshold", "failure_threshold"],
    ["recovery_threshold", "recovery_threshold"],
    ["alert_on_slow", "alert_on_slow"],
    ["slow_threshold_ms", "slow_threshold_ms"],
    ["renotify_minutes", "renotify_minutes"],
    ["muted_until", "muted_until"],
  ];

  for (const [key, column] of fields) {
    if (input[key] === undefined) continue;
    params.push(input[key]);
    assignments.push(`${column} = $${params.length}`);
  }

  if (assignments.length > 0) {
    assignments.push("updated_at = now()");

    await execute(
      `INSERT INTO alert_policies (monitor_id) VALUES ($1)
       ON CONFLICT (monitor_id) DO NOTHING`,
      [monitorId]
    );

    await execute(
      `UPDATE alert_policies SET ${assignments.join(", ")} WHERE monitor_id = $1`,
      params
    );
  }

  if (input.channel_ids !== undefined) {
    await setMonitorChannels(monitorId, input.channel_ids);
  }

  return getPolicy(monitorId);
}

/** Replaces the routing wholesale — an empty list means "org defaults". */
export async function setMonitorChannels(
  monitorId: number,
  channelIds: number[]
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(`DELETE FROM monitor_channels WHERE monitor_id = $1`, [
      monitorId,
    ]);

    if (channelIds.length === 0) return;

    // Only channels belonging to this monitor's organization: an id from
    // another workspace would otherwise route our alerts into their Slack.
    await client.query(
      `INSERT INTO monitor_channels (monitor_id, channel_id)
       SELECT $1, c.id
         FROM notification_channels c
         JOIN monitors m ON m.org_id = c.org_id
        WHERE m.id = $1 AND c.id = ANY($2::bigint[])`,
      [monitorId, channelIds]
    );
  });
}

export async function getMonitorChannelIds(monitorId: number): Promise<number[]> {
  const rows = await query<{ channel_id: number }>(
    `SELECT channel_id FROM monitor_channels WHERE monitor_id = $1`,
    [monitorId]
  );

  return rows.map((row) => row.channel_id);
}

/** Every active monitor, for re-registering schedules after a restart. */
export async function listSchedulableMonitors(): Promise<
  Array<{ id: number; url: string; interval_seconds: number }>
> {
  return query(
    `SELECT id, url, interval_seconds FROM monitors WHERE paused = false`
  );
}
