import crypto from "crypto";
import { z } from "zod";
import { assertWebhookUrl, postJson } from "../outbound";
import {
  ChannelConfigError,
  type AlertEvent,
  type ChannelProvider,
  type NotificationChannelRecord,
} from "../types";

const configSchema = z.object({
  url: z.string(),
  /** Optional shared secret used to sign the body. */
  secret: z.string().max(200).optional(),
});

export const webhookProvider: ChannelProvider = {
  type: "webhook",

  async validateConfig(config) {
    const parsed = configSchema.safeParse(config);

    if (!parsed.success) {
      throw new ChannelConfigError("A webhook URL is required");
    }

    const url = await assertWebhookUrl(parsed.data.url);

    return parsed.data.secret ? { url, secret: parsed.data.secret } : { url };
  },

  async send(channel: NotificationChannelRecord, event: AlertEvent) {
    const parsed = configSchema.safeParse(channel.config);

    if (!parsed.success) {
      throw new ChannelConfigError("This webhook channel is misconfigured");
    }

    const payload = {
      event: event.type,
      organization: event.organizationName,
      monitor: {
        id: event.monitor.id,
        name: event.monitor.name,
        url: event.monitor.url,
      },
      status: event.headline,
      root_cause: event.rootCause,
      detail: event.detail,
      incident_id: event.incidentId,
      duration_seconds: event.durationSeconds,
      occurred_at: event.occurredAt.toISOString(),
      dashboard_url: event.dashboardUrl,
    };

    const headers: Record<string, string> = { "X-RouteRX-Event": event.type };

    if (parsed.data.secret) {
      // Lets the receiver prove the payload came from us and was not
      // replayed or edited in transit. Same scheme as GitHub's.
      const signature = crypto
        .createHmac("sha256", parsed.data.secret)
        .update(JSON.stringify(payload))
        .digest("hex");

      headers["X-RouteRX-Signature"] = `sha256=${signature}`;
    }

    await postJson(parsed.data.url, payload, headers);
  },
};
