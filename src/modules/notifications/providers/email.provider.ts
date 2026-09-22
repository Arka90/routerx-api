import { z } from "zod";
import {
  ALERT_FROM,
  emailButton,
  emailLayout,
  emailParagraph,
  emailPill,
  emailTable,
  escapeHtml,
  sendMail,
  type EmailTone,
} from "../../../core/mail/mailer";
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

function toneFor(event: AlertEvent): EmailTone {
  switch (event.type) {
    case "UP":
      return "up";
    case "DEGRADED":
      return "degraded";
    case "TEST":
      return "brand";
    case "TLS_EXPIRY":
      return "degraded";
    default:
      return "down";
  }
}

function eyebrowFor(event: AlertEvent): string {
  switch (event.type) {
    case "UP":
      return "Recovered";
    case "DEGRADED":
      return "Degraded";
    case "REMINDER":
      return "Still down";
    case "TLS_EXPIRY":
      return "Certificate";
    case "TEST":
      return "Test alert";
    default:
      return "Incident";
  }
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

/** "HTTP_5XX" → "HTTP 5xx", "TLS_HANDSHAKE_FAILED" → "TLS handshake failed". */
function humanizeRootCause(rootCause: string): string {
  return rootCause
    .toLowerCase()
    .split("_")
    .map((word, index) => {
      if (["dns", "tcp", "tls", "http", "ssl"].includes(word)) return word.toUpperCase();
      return index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    })
    .join(" ");
}

export function renderAlertHtml(event: AlertEvent): string {
  const tone = toneFor(event);
  const label = event.monitor.name ?? event.monitor.url;

  const rows: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: "Status", value: emailPill(event.headline, tone) },
    { label: "Endpoint", value: escapeHtml(event.monitor.url), mono: true },
  ];

  if (event.rootCause) {
    rows.push({ label: "Root cause", value: escapeHtml(humanizeRootCause(event.rootCause)) });
  }
  if (event.detail) rows.push({ label: "Detail", value: escapeHtml(event.detail), mono: true });
  if (event.durationSeconds !== null) {
    rows.push({ label: "Downtime", value: escapeHtml(formatDuration(event.durationSeconds)) });
  }
  rows.push({ label: "Detected", value: escapeHtml(event.occurredAt.toISOString()), mono: true });
  rows.push({ label: "Workspace", value: escapeHtml(event.organizationName) });

  const lead =
    event.type === "UP"
      ? `${escapeHtml(label)} is responding normally again.`
      : event.type === "DEGRADED"
        ? `${escapeHtml(label)} is answering, but slower than its threshold allows.`
        : event.type === "REMINDER"
          ? `${escapeHtml(label)} is still down and nobody has acknowledged the incident yet.`
          : event.type === "TEST"
            ? `This is a test from RouteRX. If you can read it, alerts for this workspace will reach this address.`
            : `${escapeHtml(label)} failed enough consecutive checks to be confirmed down.`;

  return emailLayout(
    `${escapeHtml(label)} is ${escapeHtml(event.headline.toLowerCase())}`,
    emailParagraph(lead) +
      emailTable(rows, { tone }) +
      emailButton(event.dashboardUrl, "Open monitor") +
      (event.type === "DOWN" || event.type === "REMINDER"
        ? emailParagraph(
            "Acknowledging the incident in RouteRX stops reminders for everyone on the team.",
            { muted: true }
          )
        : ""),
    {
      eyebrow: eyebrowFor(event),
      tone,
      preheader: `${label} — ${event.headline}${event.rootCause ? ` · ${humanizeRootCause(event.rootCause)}` : ""}`,
      footerNote: `Sent to the alert channel for ${escapeHtml(event.organizationName)}. Manage channels and per-monitor routing in RouteRX.`,
    }
  );
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
