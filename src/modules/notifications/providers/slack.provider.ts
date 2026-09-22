import { assertWebhookUrl, postJson } from "../outbound";
import {
  ChannelConfigError,
  type AlertEvent,
  type ChannelProvider,
  type NotificationChannelRecord,
} from "../types";

const SLACK_HOSTS = ["hooks.slack.com"];

function emojiFor(event: AlertEvent): string {
  if (event.type === "UP") return "✅";
  if (event.type === "DEGRADED") return "🐢";
  if (event.type === "TLS_EXPIRY") return "🔒";
  return "🚨";
}

export const slackProvider: ChannelProvider = {
  type: "slack",

  async validateConfig(config) {
    const url = await assertWebhookUrl(config.webhook_url, SLACK_HOSTS);
    return { webhook_url: url };
  },

  async send(channel: NotificationChannelRecord, event: AlertEvent) {
    const webhookUrl = channel.config.webhook_url;

    if (typeof webhookUrl !== "string") {
      throw new ChannelConfigError("This Slack channel has no webhook URL");
    }

    const label = event.monitor.name ?? event.monitor.url;

    const fields = [
      { type: "mrkdwn", text: `*Status*\n${event.headline}` },
      { type: "mrkdwn", text: `*Endpoint*\n<${event.monitor.url}|${event.monitor.url}>` },
    ];

    if (event.rootCause) {
      fields.push({
        type: "mrkdwn",
        text: `*Root cause*\n${event.rootCause.replace(/_/g, " ")}`,
      });
    }

    if (event.durationSeconds !== null) {
      fields.push({
        type: "mrkdwn",
        text: `*Downtime*\n${Math.round(event.durationSeconds / 60)}m`,
      });
    }

    await postJson(webhookUrl, {
      text: `${emojiFor(event)} ${label} — ${event.headline}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${emojiFor(event)} *${label}* — ${event.headline}`,
          },
        },
        { type: "section", fields },
        ...(event.detail
          ? [
              {
                type: "context",
                elements: [{ type: "mrkdwn", text: event.detail.slice(0, 2000) }],
              },
            ]
          : []),
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Open monitor" },
              url: event.dashboardUrl,
            },
          ],
        },
      ],
    });
  },
};
