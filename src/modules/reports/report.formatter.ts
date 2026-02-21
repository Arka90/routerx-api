import nodemailer from "nodemailer";
import "dotenv/config";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export interface MonitorReport {
  url: string;
  uptime: number;
  incidents: number;
  downtime: number;   // seconds
  longest: number;    // seconds
}

export function buildWeeklyEmail(reports: MonitorReport[]): string {
  const rows = reports
    .map(
      (r) => `
      <tr>
        <td style="padding:8px 12px; border-bottom:1px solid #eee;">${r.url}</td>
        <td style="padding:8px 12px; border-bottom:1px solid #eee; text-align:center;">${r.uptime.toFixed(2)}%</td>
        <td style="padding:8px 12px; border-bottom:1px solid #eee; text-align:center;">${r.incidents}</td>
        <td style="padding:8px 12px; border-bottom:1px solid #eee; text-align:center;">${Math.round(r.downtime / 60)} min</td>
        <td style="padding:8px 12px; border-bottom:1px solid #eee; text-align:center;">${Math.round(r.longest / 60)} min</td>
      </tr>`
    )
    .join("");

  return `
    <div style="font-family: sans-serif; max-width: 640px; margin: auto;">
      <h2>📊 RouteRx Weekly Reliability Report</h2>
      <p>Here's how your monitors performed over the last 7 days.</p>

      <table style="width:100%; border-collapse:collapse; margin-top:16px;">
        <thead>
          <tr style="background:#f5f5f5;">
            <th style="padding:8px 12px; text-align:left;">Monitor</th>
            <th style="padding:8px 12px;">Uptime</th>
            <th style="padding:8px 12px;">Incidents</th>
            <th style="padding:8px 12px;">Downtime</th>
            <th style="padding:8px 12px;">Longest</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>

      <p style="margin-top:24px; color:#888; font-size:13px;">
        Keep shipping 🚀 — RouteRx
      </p>
    </div>
  `;
}

export async function sendWeeklyReport(email: string, html: string) {
  try {
    await transporter.sendMail({
      from: `"RouteRx Reports" <${process.env.ALERT_FROM}>`,
      to: email,
      subject: "📊 Your Weekly Reliability Report — RouteRx",
      html,
    });
  } catch (err) {
    console.error(`Failed to send weekly report to ${email}:`, err);
  }
}
