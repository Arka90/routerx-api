import nodemailer from "nodemailer";
import "dotenv/config";

/**
 * One transport for the whole process. It was previously constructed
 * separately in the auth service, the alert provider and the report
 * formatter, so each held its own connection pool and any change to
 * delivery had to be made in three places.
 */
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: Number(process.env.SMTP_PORT) === 465,
  auth:
    process.env.SMTP_USER || process.env.SMTP_PASS
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
});

export interface MailMessage {
  to: string | string[];
  subject: string;
  html: string;
  /** Defaults to the general sender; alerts pass the alert sender. */
  from?: string;
}

export async function sendMail(message: MailMessage): Promise<void> {
  const from = message.from ?? `"RouteRX" <${process.env.GENERAL_FROM}>`;

  await transporter.sendMail({
    from,
    to: Array.isArray(message.to) ? message.to.join(", ") : message.to,
    subject: message.subject,
    html: message.html,
  });
}

export const ALERT_FROM = `"RouteRX Alerts" <${process.env.ALERT_FROM}>`;

/** Shared chrome so every RouteRX email looks like it came from one product. */
export function emailLayout(title: string, bodyHtml: string): string {
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
      <div style="font-weight:600;font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:#666;margin-bottom:16px">RouteRX</div>
      <h1 style="font-size:20px;font-weight:600;margin:0 0 16px">${title}</h1>
      ${bodyHtml}
      <hr style="border:none;border-top:1px solid #eee;margin:28px 0 12px" />
      <p style="font-size:12px;color:#888;margin:0">You're receiving this because you monitor endpoints with RouteRX.</p>
    </div>
  `;
}
