import { execute, query, queryOne } from "../../core/db/client";
import { getProvider } from "../notifications/registry";
import type { ChannelType, NotificationChannelRecord } from "../notifications/types";

export async function listChannels(orgId: number): Promise<NotificationChannelRecord[]> {
  return query<NotificationChannelRecord>(
    `SELECT * FROM notification_channels WHERE org_id = $1 ORDER BY created_at ASC`,
    [orgId]
  );
}

export async function getChannel(
  orgId: number,
  channelId: number
): Promise<NotificationChannelRecord | undefined> {
  return queryOne<NotificationChannelRecord>(
    `SELECT * FROM notification_channels WHERE id = $1 AND org_id = $2`,
    [channelId, orgId]
  );
}

export async function createChannel(
  orgId: number,
  type: ChannelType,
  name: string,
  config: Record<string, unknown>
): Promise<NotificationChannelRecord> {
  // Validated here rather than at send time, so a typo surfaces while someone
  // is still looking at the form instead of during an outage.
  const validated = await getProvider(type).validateConfig(config);

  const row = await queryOne<NotificationChannelRecord>(
    `INSERT INTO notification_channels (org_id, type, name, config)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING *`,
    [orgId, type, name, JSON.stringify(validated)]
  );

  return row!;
}

export async function updateChannel(
  orgId: number,
  channelId: number,
  patch: { name?: string; config?: Record<string, unknown>; enabled?: boolean }
): Promise<NotificationChannelRecord | undefined> {
  const existing = await getChannel(orgId, channelId);
  if (!existing) return undefined;

  const assignments: string[] = [];
  const params: unknown[] = [];

  if (patch.name !== undefined) {
    params.push(patch.name);
    assignments.push(`name = $${params.length}`);
  }

  if (patch.enabled !== undefined) {
    params.push(patch.enabled);
    assignments.push(`enabled = $${params.length}`);
  }

  if (patch.config !== undefined) {
    const validated = await getProvider(existing.type).validateConfig(patch.config);
    params.push(JSON.stringify(validated));
    assignments.push(`config = $${params.length}::jsonb`);
  }

  if (assignments.length === 0) return existing;

  params.push(channelId, orgId);

  const rows = await query<NotificationChannelRecord>(
    `UPDATE notification_channels SET ${assignments.join(", ")}
      WHERE id = $${params.length - 1} AND org_id = $${params.length}
      RETURNING *`,
    params
  );

  return rows[0];
}

export async function deleteChannel(orgId: number, channelId: number): Promise<boolean> {
  const removed = await execute(
    `DELETE FROM notification_channels WHERE id = $1 AND org_id = $2`,
    [channelId, orgId]
  );

  return removed > 0;
}

/**
 * Every organization starts with an email channel addressed to its members,
 * so a brand-new monitor alerts someone without any setup at all.
 */
export async function ensureDefaultChannel(orgId: number): Promise<void> {
  await execute(
    `INSERT INTO notification_channels (org_id, type, name, config)
     SELECT $1, 'email', 'Workspace email', '{"recipients":[]}'::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM notification_channels WHERE org_id = $1
      )`,
    [orgId]
  );
}
