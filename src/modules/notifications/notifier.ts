import { execute, query } from "../../core/db/client";
import { config } from "../../core/config";
import { getProvider } from "./registry";
import type {
  AlertEvent,
  AlertEventType,
  NotificationChannelRecord,
} from "./types";

export interface DispatchParams {
  orgId: number;
  organizationName: string;
  monitor: { id: number; name: string | null; url: string };
  type: AlertEventType;
  headline: string;
  rootCause?: string | null;
  detail?: string | null;
  incidentId?: number | null;
  durationSeconds?: number | null;
  /** Send to exactly these channels instead of the monitor's routing. */
  channelIds?: number[];
}

/**
 * Channels explicitly linked to the monitor, or — when none are — every
 * enabled channel in the organization.
 *
 * The fallback is deliberate: someone who adds a Slack channel and sees no
 * Slack alerts has been failed by the product, not by their configuration.
 */
async function resolveChannels(
  orgId: number,
  monitorId: number,
  explicit?: number[]
): Promise<NotificationChannelRecord[]> {
  if (explicit && explicit.length > 0) {
    return query<NotificationChannelRecord>(
      `SELECT * FROM notification_channels
        WHERE org_id = $1 AND id = ANY($2::bigint[]) AND enabled = true`,
      [orgId, explicit]
    );
  }

  const linked = await query<NotificationChannelRecord>(
    `SELECT c.*
       FROM notification_channels c
       JOIN monitor_channels mc ON mc.channel_id = c.id
      WHERE mc.monitor_id = $1 AND c.enabled = true`,
    [monitorId]
  );

  if (linked.length > 0) return linked;

  return query<NotificationChannelRecord>(
    `SELECT * FROM notification_channels WHERE org_id = $1 AND enabled = true`,
    [orgId]
  );
}

/**
 * Fan an alert out across channels.
 *
 * Every channel is attempted even if an earlier one throws — a Slack webhook
 * that has been deleted must not stop the email going out — and each attempt
 * is recorded so "why didn't I get paged" has an answer.
 */
export async function dispatchAlert(params: DispatchParams): Promise<void> {
  const channels = await resolveChannels(
    params.orgId,
    params.monitor.id,
    params.channelIds
  );

  if (channels.length === 0) {
    console.warn(
      `No enabled notification channel for monitor ${params.monitor.id}; alert not delivered`
    );
    return;
  }

  const event: AlertEvent = {
    type: params.type,
    monitor: params.monitor,
    organizationName: params.organizationName,
    headline: params.headline,
    rootCause: params.rootCause ?? null,
    detail: params.detail ?? null,
    occurredAt: new Date(),
    incidentId: params.incidentId ?? null,
    durationSeconds: params.durationSeconds ?? null,
    dashboardUrl: `${config.appUrl}/monitor/${params.monitor.id}`,
  };

  await Promise.all(
    channels.map(async (channel) => {
      try {
        await getProvider(channel.type).send(channel, event);
        await recordDelivery(params, channel, "sent", null);
      } catch (error) {
        const message = (error as Error).message;
        console.error(
          `Alert delivery failed (${channel.type} #${channel.id}): ${message}`
        );
        await recordDelivery(params, channel, "failed", message);
      }
    })
  );
}

async function recordDelivery(
  params: DispatchParams,
  channel: NotificationChannelRecord,
  status: "sent" | "failed",
  error: string | null
): Promise<void> {
  try {
    await execute(
      `INSERT INTO alert_deliveries
         (monitor_id, incident_id, channel_id, channel_type, event, status, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        params.monitor.id,
        params.incidentId ?? null,
        channel.id,
        channel.type,
        params.type,
        status,
        error?.slice(0, 500) ?? null,
      ]
    );
  } catch (writeError) {
    // Losing the audit row must not turn a delivered alert into a failed one.
    console.error("Could not record alert delivery:", writeError);
  }
}
