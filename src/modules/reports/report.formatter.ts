import { config } from "../../core/config";
import {
  ALERT_FROM,
  EMAIL_COLORS,
  emailButton,
  emailLayout,
  emailParagraph,
  escapeHtml,
  sendMail,
} from "../../core/mail/mailer";

export interface MonitorReport {
  url: string;
  uptime: number;
  incidents: number;
  downtime: number; // seconds
  longest: number; // seconds
}

function minutes(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

function uptimeColor(uptime: number): string {
  if (uptime >= 99.9) return EMAIL_COLORS.up;
  if (uptime >= 99) return EMAIL_COLORS.degraded;
  return EMAIL_COLORS.down;
}

/**
 * Hostname on one line, path underneath. A full URL in a narrow column wraps
 * mid-word, and the hostname is what people scan the table by anyway.
 */
function monitorLabel(url: string): string {
  let host = url;
  let path = "";
  try {
    const parsed = new URL(url);
    host = parsed.host;
    path = parsed.pathname === "/" && !parsed.search ? "" : `${parsed.pathname}${parsed.search}`;
  } catch {
    // Stored before URL validation existed; show it as-is.
  }

  return (
    `<span style="font-family:${MONO};font-size:12px;color:${EMAIL_COLORS.ink};word-break:break-all">${escapeHtml(host)}</span>` +
    (path
      ? `<br><span style="font-family:${MONO};font-size:11px;color:${EMAIL_COLORS.subtle};word-break:break-all">${escapeHtml(path)}</span>`
      : "")
  );
}

/** One big number with a label, three of them across the top of the report. */
function stat(label: string, value: string, color: string = EMAIL_COLORS.ink): string {
  return `
    <td width="33%" style="padding:14px 16px;border:1px solid ${EMAIL_COLORS.border};border-radius:10px;background:${EMAIL_COLORS.panel}">
      <div style="font-family:${FONT};font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${EMAIL_COLORS.subtle}">${label}</div>
      <div style="font-family:${FONT};font-size:22px;font-weight:600;letter-spacing:-0.01em;color:${color};margin-top:6px">${value}</div>
    </td>`;
}

export function buildWeeklyEmail(
  organizationName: string,
  reports: MonitorReport[]
): string {
  const totalIncidents = reports.reduce((sum, report) => sum + report.incidents, 0);
  const totalDowntime = reports.reduce((sum, report) => sum + report.downtime, 0);
  const averageUptime =
    reports.length === 0
      ? 100
      : reports.reduce((sum, report) => sum + report.uptime, 0) / reports.length;

  const headerCell = (label: string, align: "left" | "right") =>
    `<th align="${align}" style="padding:0 12px 8px ${align === "left" ? "0" : "12px"};font-family:${FONT};font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${EMAIL_COLORS.subtle}">${label}</th>`;

  const rows = reports
    .map((report, index) => {
      const border = index === reports.length - 1 ? "" : `border-bottom:1px solid ${EMAIL_COLORS.border};`;
      const cell = (content: string, align: "left" | "right", extra = "") =>
        `<td align="${align}" style="padding:10px 12px 10px ${align === "left" ? "0" : "12px"};${border}font-family:${FONT};font-size:13px;color:${EMAIL_COLORS.text};${extra}">${content}</td>`;

      return `
        <tr>
          ${cell(monitorLabel(report.url), "left")}
          ${cell(`${report.uptime.toFixed(2)}%`, "right", `font-weight:600;color:${uptimeColor(report.uptime)}`)}
          ${cell(String(report.incidents), "right")}
          ${cell(minutes(report.downtime), "right")}
          ${cell(minutes(report.longest), "right")}
        </tr>`;
    })
    .join("");

  const table =
    reports.length === 0
      ? emailParagraph("No monitors reported this week. Add one and next week's report will have something to say.", {
          muted: true,
        })
      : `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:4px 0 18px">
        <thead>
          <tr>
            ${headerCell("Monitor", "left")}
            ${headerCell("Uptime", "right")}
            ${headerCell("Incidents", "right")}
            ${headerCell("Downtime", "right")}
            ${headerCell("Longest", "right")}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;

  return emailLayout(
    `${escapeHtml(organizationName)}: the last 7 days`,
    emailParagraph(
      `Here's how the ${reports.length} monitor${reports.length === 1 ? "" : "s"} in
       <strong>${escapeHtml(organizationName)}</strong> did this week.`
    ) +
      `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="6" border="0" style="margin:0 -6px 12px;border-collapse:separate">
        <tr>
          ${stat("Avg uptime", `${averageUptime.toFixed(2)}%`, uptimeColor(averageUptime))}
          ${stat("Incidents", String(totalIncidents), totalIncidents > 0 ? EMAIL_COLORS.down : EMAIL_COLORS.ink)}
          ${stat("Downtime", minutes(totalDowntime))}
        </tr>
      </table>` +
      table +
      emailButton(`${config.appUrl}/dashboard`, "Open dashboard"),
    {
      eyebrow: "Weekly report",
      tone: averageUptime >= 99.9 ? "up" : averageUptime >= 99 ? "degraded" : "down",
      preheader: `${averageUptime.toFixed(2)}% average uptime, ${totalIncidents} incident${totalIncidents === 1 ? "" : "s"}, ${minutes(totalDowntime)} of downtime.`,
      footerNote: `Sent weekly to everyone in ${escapeHtml(organizationName)}.`,
    }
  );
}

export async function sendWeeklyReport(
  recipients: string[],
  html: string
): Promise<void> {
  await sendMail({
    from: ALERT_FROM,
    to: recipients,
    subject: "Your weekly RouteRX reliability report",
    html,
  });
}
