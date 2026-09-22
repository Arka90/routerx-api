import { ALERT_FROM, emailLayout, sendMail } from "../../core/mail/mailer";

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

export function buildWeeklyEmail(
  organizationName: string,
  reports: MonitorReport[]
): string {
  const rows = reports
    .map((report) => {
      const healthy = report.uptime >= 99.9;

      return `
        <tr>
          <td style="padding:10px 12px 10px 0;border-bottom:1px solid #eee;font-size:13px">${escapeHtml(report.url)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:right;font-size:13px;font-weight:600;color:${healthy ? "#059669" : "#dc2626"}">${report.uptime.toFixed(2)}%</td>
          <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:right;font-size:13px">${report.incidents}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:right;font-size:13px">${minutes(report.downtime)}</td>
          <td style="padding:10px 0 10px 12px;border-bottom:1px solid #eee;text-align:right;font-size:13px">${minutes(report.longest)}</td>
        </tr>`;
    })
    .join("");

  return emailLayout(
    `${organizationName} — last 7 days`,
    `
      <table style="width:100%;border-collapse:collapse;margin-top:8px">
        <thead>
          <tr>
            <th style="text-align:left;padding-bottom:8px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#888">Monitor</th>
            <th style="text-align:right;padding-bottom:8px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#888">Uptime</th>
            <th style="text-align:right;padding-bottom:8px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#888">Incidents</th>
            <th style="text-align:right;padding-bottom:8px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#888">Downtime</th>
            <th style="text-align:right;padding-bottom:8px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#888">Longest</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
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
