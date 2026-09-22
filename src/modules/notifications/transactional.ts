import { ALERT_FROM, emailLayout, sendMail } from "../../core/mail/mailer";

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
      `Join ${params.organizationName}`,
      `
        <p style="font-size:14px;line-height:1.6;color:#333">
          <strong>${params.inviterEmail}</strong> invited you to join
          <strong>${params.organizationName}</strong> on RouteRX as
          <strong>${params.role}</strong>.
        </p>
        <p style="margin:24px 0">
          <a href="${params.acceptUrl}"
             style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:11px 20px;border-radius:6px;font-size:14px;font-weight:500">
            Accept invitation
          </a>
        </p>
        <p style="font-size:13px;color:#666">
          This link works once and expires in a few days. If you weren't
          expecting it, you can ignore this email.
        </p>
      `
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
        `<p style="font-size:14px;line-height:1.6;color:#333">
           ${
             created
               ? `You're now monitoring <strong>${url}</strong>. We'll alert you if it goes down.`
               : `You've stopped monitoring <strong>${url}</strong>. No further alerts will be sent for it.`
           }
         </p>`
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

  await sendMail({
    from: ALERT_FROM,
    to: recipients,
    subject: `TLS certificate for ${url} expires in ${Math.floor(daysLeft)} days`,
    html: emailLayout(
      "Certificate expiring soon",
      `
        <p style="font-size:14px;line-height:1.6;color:#333">
          The TLS certificate for <strong>${url}</strong> expires on
          <strong>${expiryDate.toISOString().slice(0, 10)}</strong> —
          ${Math.floor(daysLeft)} day(s) from now.
        </p>
        <p style="font-size:14px;line-height:1.6;color:#333">
          Renew it before then to avoid an outage that looks like a total
          failure to every visitor.
        </p>
      `
    ),
  });
}
