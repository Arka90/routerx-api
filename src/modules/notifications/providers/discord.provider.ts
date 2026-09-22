import { assertWebhookUrl, postJson } from "../outbound";
import {
  ChannelConfigError,
  type AlertEvent,
  type ChannelProvider,
  type NotificationChannelRecord,
} from "../types";

const DISCORD_HOSTS = ["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"];

function colorFor(event: AlertEvent): number {
  if (event.type === "UP") return 0x059669;
  if (event.type === "DEGRADED") return 0xd97706;
  return 0xdc2626;
}

export const discordProvider: ChannelProvider = {
  type: "discord",

  async validateConfig(config) {
    const url = await assertWebhookUrl(config.webhook_url, DISCORD_HOSTS);
    return { webhook_url: url };
  },

  async send(channel: NotificationChannelRecord, event: AlertEvent) {
    const webhookUrl = channel.config.webhook_url;

    if (typeof webhookUrl !== "string") {
      throw new ChannelConfigError("This Discord channel has no webhook URL");
    }

    const label = event.monitor.name ?? event.monitor.url;

    const fields = [
      { name: "Status", value: event.headline, inline: true },
      { name: "Endpoint", value: event.monitor.url, inline: false },
    ];

    if (event.rootCause) {
      fields.push({
        name: "Root cause",
        value: event.rootCause.replace(/_/g, " "),
        inline: true,
      });
    }

    if (event.detail) {
      fields.push({ name: "Detail", value: event.detail.slice(0, 1000), inline: false });
    }

    await postJson(webhookUrl, {
      username: "RouteRX",
      embeds: [
        {
          title: `${label} — ${event.headline}`,
          url: event.dashboardUrl,
          color: colorFor(event),
          fields,
          timestamp: event.occurredAt.toISOString(),
        },
      ],
    });
  },
};
