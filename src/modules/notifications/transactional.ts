import { config } from "../../core/config";
import {
  ALERT_FROM,
  emailButton,
  emailLayout,
  emailMono,
  emailParagraph,
  emailPill,
  emailTable,
  escapeHtml,
  sendMail,
} from "../../core/mail/mailer";

/**
 * One-off emails tied to a user action, as opposed to the alert pipeline in
 * notifier.ts, which fans an incident out across configured channels.
 */

export async function sendInviteEmail(params: {
  to: string;
  inviterEmail: string;
  organizationName: string;
  acceptUrl: string;
  role: string;
}): Promise<void> {
  await sendMail({
    to: params.to,
    subject: `${params.inviterEmail} invited you to ${params.organizationName} on RouteRX`,
    html: emailLayout(
      `Join ${escapeHtml(params.organizationName)}`,
      emailParagraph(
        `<strong>${escapeHtml(params.inviterEmail)}</strong> invited you to work on
         <strong>${escapeHtml(params.organizationName)}</strong> in RouteRX.`
      ) +
        emailTable([
          { label: "Workspace", value: escapeHtml(params.organizationName) },
          { label: "Role", value: emailPill(params.role, "brand") },
          { label: "Invited by", value: escapeHtml(params.inviterEmail), mono: true },
        ]) +
        emailButton(params.acceptUrl, "Accept invitation") +
        emailParagraph(
          "This link works once and expires in a few days. If you weren't expecting it, you can ignore this email.",
          { muted: true }
        ),
      {
        eyebrow: "Invitation",
        preheader: `${params.inviterEmail} invited you to ${params.organizationName} as ${params.role}.`,
        footerNote: `Sent because ${escapeHtml(params.inviterEmail)} entered this address in RouteRX.`,
      }
    ),
  });
}

export async function sendMonitorNotification(
  email: string,
  url: string,
  event: "CREATED" | "DELETED"
): Promise<void> {
  const created = event === "CREATED";

  try {
    await sendMail({
      from: ALERT_FROM,
      to: email,
      subject: created ? `Now watching ${url}` : `Stopped watching ${url}`,
      html: emailLayout(
        created ? "Monitor created" : "Monitor deleted",
        emailParagraph(
          created
            ? `You're now monitoring ${emailMono(url)}. The first check runs within a minute, and we'll alert you if it goes down.`
            : `You've stopped monitoring ${emailMono(url)}. No further alerts will be sent for it.`
        ) +
          emailTable([
            { label: "Endpoint", value: escapeHtml(url), mono: true },
            {
              label: "Status",
              value: emailPill(created ? "Watching" : "Removed", created ? "up" : "neutral"),
            },
          ]) +
          (created ? emailButton(`${config.appUrl}/dashboard`, "Open dashboard") : ""),
        { eyebrow: "Monitor", tone: created ? "up" : "neutral" }
      ),
    });
  } catch (error) {
    // Informational only — never fail the API call that triggered it.
    console.error(`Could not send monitor ${event} email:`, error);
  }
}

export async function sendTlsExpiryAlert(
  recipients: string[],
  url: string,
  expiryDate: Date,
  daysLeft: number
): Promise<void> {
  if (recipients.length === 0) return;

  const days = Math.floor(daysLeft);
  const urgent = days <= 7;

  await sendMail({
    from: ALERT_FROM,
    to: recipients,
    subject: `TLS certificate for ${url} expires in ${days} days`,
    html: emailLayout(
      urgent ? "Certificate expires this week" : "Certificate expiring soon",
      emailParagraph(
        `The TLS certificate for ${emailMono(url)} is about to expire. Once it does,
         every visitor sees a security error and the site reads as a total outage.`
      ) +
        emailTable(
          [
            { label: "Endpoint", value: escapeHtml(url), mono: true },
            { label: "Expires", value: escapeHtml(expiryDate.toISOString().slice(0, 10)), mono: true },
            {
              label: "Days left",
              value: emailPill(`${days} day${days === 1 ? "" : "s"}`, urgent ? "down" : "degraded"),
            },
          ],
          { tone: urgent ? "down" : "degraded" }
        ) +
        emailParagraph("Renew it before then. RouteRX keeps checking and will stop reminding you once the new certificate is served.", {
          muted: true,
        }) +
        emailButton(`${config.appUrl}/dashboard`, "Open dashboard"),
      {
        eyebrow: "Certificate",
        tone: urgent ? "down" : "degraded",
        preheader: `${url} expires in ${days} days.`,
      }
    ),
  });
}
