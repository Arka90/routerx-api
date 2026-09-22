import { z } from "zod";
import { ALERT_FROM, emailLayout, sendMail } from "../../../core/mail/mailer";
import { query } from "../../../core/db/client";
import {
  ChannelConfigError,
  type AlertEvent,
  type ChannelProvider,
  type NotificationChannelRecord,
} from "../types";

const configSchema = z.object({
  // Empty means "everyone in the organization", which is what people expect
  // from a channel literally called Email.
  recipients: z.array(z.string().email()).max(20).default([]),
});

function colorFor(event: AlertEvent): string {
  if (event.type === "UP") return "#059669";
  if (event.type === "DEGRADED") return "#d97706";
  return "#dc2626";
}

export function renderAlertHtml(event: AlertEvent): string {
  const rows: Array<[string, string]> = [
    ["Endpoint", event.monitor.url],
    ["Status", event.headline],
  ];

  if (event.rootCause) rows.push(["Root cause", event.rootCause.replace(/_/g, " ")]);
  if (event.detail) rows.push(["Detail", event.detail]);
  if (event.durationSeconds !== null) {
    const minutes = Math.floor(event.durationSeconds / 60);
    const seconds = event.durationSeconds % 60;
    rows.push(["Downtime", minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`]);
  }
  rows.push(["Detected at", event.occurredAt.toISOString()]);

  const table = rows
    .map(
      ([label, value]) => `
      <tr>
        <td style="padding:6px 12px 6px 0;color:#666;font-size:13px;white-space:nowrap">${label}</td>
        <td style="padding:6px 0;font-size:13px;font-family:ui-monospace,SFMono-Regular,monospace">${escapeHtml(value)}</td>
      </tr>`
    )
    .join("");

  return emailLayout(
    `${event.monitor.name ?? event.monitor.url} is ${event.headline.toLowerCase()}`,
    `
      <div style="border-left:3px solid ${colorFor(event)};padding-left:14px;margin-bottom:20px">
        <table style="border-collapse:collapse">${table}</table>
      </div>
      <a href="${event.dashboardUrl}"
         style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:13px;font-weight:500">
        Open monitor
      </a>
    `
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const emailProvider: ChannelProvider = {
  type: "email",

  async validateConfig(config) {
    const parsed = configSchema.safeParse(config);

    if (!parsed.success) {
      throw new ChannelConfigError("Recipients must be a list of valid email addresses");
    }

    return parsed.data;
  },

  async send(channel: NotificationChannelRecord, event: AlertEvent) {
    const { recipients } = configSchema.parse(channel.config);

    const to =
      recipients.length > 0
        ? recipients
        : (
            await query<{ email: string }>(
              `SELECT u.email::text AS email
                 FROM org_members m
                 JOIN users u ON u.id = m.user_id
                WHERE m.org_id = $1`,
              [channel.org_id]
            )
          ).map((row) => row.email);

    if (to.length === 0) return;

    const label = event.monitor.name ?? event.monitor.url;
    const prefix = event.type === "UP" ? "Recovered" : event.headline;

    await sendMail({
      from: ALERT_FROM,
      to,
      subject: `[${prefix}] ${label}`,
      html: renderAlertHtml(event),
    });
  },
};
