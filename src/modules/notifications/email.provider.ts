import nodemailer from "nodemailer";
import { AlertPayload, NotificationProvider } from "./types";
import { db } from "../../core/db/client";
import "dotenv/config";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false, // true only for 465
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export class EmailProvider implements NotificationProvider {
  async send(payload: AlertPayload) {
    // find monitor owner
    const user = db.prepare(`
      SELECT users.email
      FROM monitors
      JOIN users ON users.id = monitors.user_id
      WHERE monitors.id = ?
    `).get(payload.monitorId) as any;

    if (!user) return;

    const subject =
      payload.status === "DOWN"
        ? `🚨 Site DOWN: ${payload.url}`
        : `✅ Site RECOVERED: ${payload.url}`;

    const html = `
      <h2>RouteRx Alert</h2>
      <p><strong>Site:</strong> ${payload.url}</p>
      <p><strong>Status:</strong> ${payload.status}</p>
      <p><strong>Time:</strong> ${payload.checkedAt.toISOString()}</p>
    `;

    await transporter.sendMail({
      from: `"RouteRx Alerts" <${process.env.ALERT_FROM}>`,
      to: user.email,
      subject,
      html,
    });

    console.log(`📧 Email sent to ${user.email}`);
  }
}

export async function sendMonitorNotification(
  email: string,
  url: string,
  event: "CREATED" | "DELETED"
) {
  const subject =
    event === "CREATED"
      ? `👀 Started watching: ${url}`
      : `🗑️ Stopped watching: ${url}`;

  const message =
    event === "CREATED"
      ? `You are now monitoring <strong>${url}</strong>. We'll alert you if it goes down.`
      : `You have stopped monitoring <strong>${url}</strong>. You will no longer receive alerts for this site.`;

  const html = `
    <h2>RouteRx Monitor Update</h2>
    <p>${message}</p>
    <p><small>${new Date().toISOString()}</small></p>
  `;

  try {
    await transporter.sendMail({
      from: `"RouteRx Alerts" <${process.env.ALERT_FROM}>`,
      to: email,
      subject,
      html,
    });
    console.log(`📧 Monitor ${event} email sent to ${email}`);
  } catch (err) {
    console.error(`Failed to send monitor ${event} email:`, err);
  }
}
