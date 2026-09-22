import nodemailer from "nodemailer";
import "dotenv/config";
import { config } from "../config";

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
  /** Plain-text alternative. Derived from the HTML when omitted. */
  text?: string;
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
    // A text part keeps spam filters happy and gives text-only clients
    // something readable instead of a wall of markup.
    text: message.text ?? htmlToText(message.html),
  });
}

export const ALERT_FROM = `"RouteRX Alerts" <${process.env.ALERT_FROM}>`;

// ---------------------------------------------------------------------------
// Email kit
//
// The same tokens as the web app's design system, inlined because email
// clients ignore stylesheets. Everything is tables, everything is light —
// dark-mode handling differs so much between clients that a light card with
// a dark brand header is the one treatment that renders the same everywhere.
//
// Hex values here deliberately never form a run of six digits: the login
// email is parsed for the first six-digit number, and "#059669" would win.
// ---------------------------------------------------------------------------

export type EmailTone = "brand" | "up" | "down" | "degraded" | "maintenance" | "neutral";

export const EMAIL_COLORS = {
  page: "#f4f4f6",
  card: "#ffffff",
  panel: "#f7f7f8",
  border: "#e4e4e8",
  ink: "#0b0b0f",
  text: "#3f3f46",
  muted: "#5b5b66",
  subtle: "#8a8a96",
  brand: "#22d3ee",
  brandInk: "#0891b2",
  up: "#10b981",
  down: "#dc2626",
  degraded: "#d97706",
  maintenance: "#0284c7",
  neutral: "#a1a1aa",
} as const;

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

const TONE_COLOR: Record<EmailTone, string> = {
  brand: EMAIL_COLORS.brand,
  up: EMAIL_COLORS.up,
  down: EMAIL_COLORS.down,
  degraded: EMAIL_COLORS.degraded,
  maintenance: EMAIL_COLORS.maintenance,
  neutral: EMAIL_COLORS.neutral,
};

/** Soft background for a tone, for pills and panels. */
const TONE_SOFT: Record<EmailTone, string> = {
  brand: "#e6fbff",
  up: "#e7f8f1",
  down: "#fdecec",
  degraded: "#fdf1e0",
  maintenance: "#e6f2fb",
  neutral: "#f1f1f3",
};

/** Text colour that reads on the soft background. */
const TONE_INK: Record<EmailTone, string> = {
  brand: EMAIL_COLORS.brandInk,
  up: "#047857",
  down: "#b91c1c",
  degraded: "#b45309",
  maintenance: "#0369a1",
  neutral: EMAIL_COLORS.muted,
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface EmailLayoutOptions {
  /** Small label on the right of the header: "Login code", "Alert", … */
  eyebrow?: string;
  /** Colour of the accent bar under the header. */
  tone?: EmailTone;
  /** Inbox preview text, hidden in the body. */
  preheader?: string;
  /** Replaces the default "why you got this" line in the footer. */
  footerNote?: string;
}

/** Shared chrome so every RouteRX email looks like it came from one product. */
export function emailLayout(
  title: string,
  bodyHtml: string,
  options: EmailLayoutOptions = {}
): string {
  const tone = options.tone ?? "brand";
  const appUrl = config.appUrl;
  const footerNote =
    options.footerNote ?? "You're receiving this because you monitor endpoints with RouteRX.";

  const preheader = options.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px">${escapeHtml(options.preheader)}${"&nbsp;&zwnj;".repeat(40)}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;padding:0;background:${EMAIL_COLORS.page};-webkit-font-smoothing:antialiased">
    ${preheader}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${EMAIL_COLORS.page}">
      <tr>
        <td align="center" style="padding:32px 16px">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px">
            <tr>
              <td style="border-radius:14px;overflow:hidden;border:1px solid ${EMAIL_COLORS.border};background:${EMAIL_COLORS.card}">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="background:${EMAIL_COLORS.ink};padding:18px 28px;border-radius:14px 14px 0 0">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                        <tr>
                          <td style="font-family:${FONT};font-size:16px;font-weight:700;color:#ffffff;letter-spacing:-0.01em;line-height:22px">
                            <span style="display:inline-block;width:8px;height:8px;border-radius:8px;background:${EMAIL_COLORS.brand};margin:0 10px 1px 0;vertical-align:middle"></span>Route<span style="color:${EMAIL_COLORS.brand}">RX</span>
                          </td>
                          ${
                            options.eyebrow
                              ? `<td align="right" style="font-family:${FONT};font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:${EMAIL_COLORS.subtle};line-height:22px">${escapeHtml(options.eyebrow)}</td>`
                              : ""
                          }
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="height:3px;background:${TONE_COLOR[tone]};font-size:0;line-height:0">&nbsp;</td>
                  </tr>
                  <tr>
                    <td style="padding:28px 28px 30px;font-family:${FONT};color:${EMAIL_COLORS.text}">
                      <h1 style="margin:0 0 14px;font-family:${FONT};font-size:21px;line-height:28px;font-weight:600;letter-spacing:-0.01em;color:${EMAIL_COLORS.ink}">${title}</h1>
                      ${bodyHtml}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:22px 24px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${EMAIL_COLORS.subtle}">
                <p style="margin:0 0 6px">${footerNote}</p>
                <p style="margin:0">
                  <a href="${appUrl}" style="color:${EMAIL_COLORS.muted};text-decoration:none;font-weight:600">RouteRX</a>
                  <span style="color:${EMAIL_COLORS.border}">&nbsp;·&nbsp;</span>
                  Uptime monitoring with root-cause forensics
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function emailParagraph(html: string, options: { muted?: boolean } = {}): string {
  const color = options.muted ? EMAIL_COLORS.muted : EMAIL_COLORS.text;
  const size = options.muted ? "13px" : "14px";
  return `<p style="margin:0 0 14px;font-family:${FONT};font-size:${size};line-height:1.6;color:${color}">${html}</p>`;
}

/** Primary call to action. Dark on light for the widest client support. */
export function emailButton(url: string, label: string): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 18px">
      <tr>
        <td style="border-radius:8px;background:${EMAIL_COLORS.ink}">
          <a href="${escapeHtml(url)}" style="display:inline-block;padding:11px 20px;font-family:${FONT};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${escapeHtml(label)}</a>
        </td>
      </tr>
    </table>`;
}

/** Small coloured status label, e.g. "Down", "Recovered". */
export function emailPill(text: string, tone: EmailTone): string {
  return `<span style="display:inline-block;padding:3px 9px;border-radius:6px;background:${TONE_SOFT[tone]};color:${TONE_INK[tone]};font-family:${FONT};font-size:12px;font-weight:600;line-height:16px;vertical-align:middle">${escapeHtml(text)}</span>`;
}

/**
 * Label/value rows in a bordered panel. Values are already-escaped HTML so
 * callers can drop a pill or a link in; pass `mono` to render them as data.
 */
export function emailTable(
  rows: Array<{ label: string; value: string; mono?: boolean }>,
  options: { tone?: EmailTone } = {}
): string {
  const accent = options.tone ? `border-left:3px solid ${TONE_COLOR[options.tone]};` : "";

  const body = rows
    .map(
      (row, index) => `
      <tr>
        <td style="padding:${index === 0 ? "14px" : "9px"} 16px ${index === rows.length - 1 ? "14px" : "0"} 16px;font-family:${FONT};font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${EMAIL_COLORS.subtle};white-space:nowrap;vertical-align:top;line-height:20px;width:1%">${escapeHtml(row.label)}</td>
        <td style="padding:${index === 0 ? "14px" : "9px"} 16px ${index === rows.length - 1 ? "14px" : "0"} 0;font-family:${row.mono ? MONO : FONT};font-size:13px;line-height:20px;color:${EMAIL_COLORS.ink};word-break:break-word">${row.value}</td>
      </tr>`
    )
    .join("");

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 18px;border:1px solid ${EMAIL_COLORS.border};${accent}border-radius:10px;background:${EMAIL_COLORS.panel};border-collapse:separate">
      ${body}
    </table>`;
}

/** A bordered panel with an optional coloured left edge. */
export function emailPanel(innerHtml: string, tone?: EmailTone): string {
  const accent = tone ? `border-left:3px solid ${TONE_COLOR[tone]};` : "";
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 18px;border:1px solid ${EMAIL_COLORS.border};${accent}border-radius:10px;background:${EMAIL_COLORS.panel};border-collapse:separate">
      <tr><td style="padding:16px;font-family:${FONT};font-size:14px;line-height:1.6;color:${EMAIL_COLORS.text}">${innerHtml}</td></tr>
    </table>`;
}

/** The one-time login code, large and copyable. */
export function emailCode(code: string): string {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 18px;border:1px solid ${EMAIL_COLORS.border};border-radius:10px;background:${EMAIL_COLORS.panel};border-collapse:separate">
      <tr>
        <td align="center" style="padding:22px 16px;font-family:${MONO};font-size:34px;font-weight:600;letter-spacing:10px;color:${EMAIL_COLORS.ink};line-height:40px">${escapeHtml(code)}</td>
      </tr>
    </table>`;
}

/** Inline monospace, for URLs and identifiers inside a sentence. */
export function emailMono(text: string): string {
  return `<span style="font-family:${MONO};font-size:13px;color:${EMAIL_COLORS.ink}">${escapeHtml(text)}</span>`;
}

export function emailLink(url: string, label: string): string {
  return `<a href="${escapeHtml(url)}" style="color:${EMAIL_COLORS.brandInk};text-decoration:underline">${escapeHtml(label)}</a>`;
}

/** Enough of a text version to be readable; not a full HTML renderer. */
export function htmlToText(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<div style="display:none[\s\S]*?<\/div>/i, "")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<\/(p|h1|h2|tr|div|table)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&zwnj;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
