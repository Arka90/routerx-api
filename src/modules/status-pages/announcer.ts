import { execute, query } from "../../core/db/client";
import { config } from "../../core/config";
import { ALERT_FROM, emailLayout, sendMail } from "../../core/mail/mailer";

type Event = "opened" | "resolved";

interface Target {
  status_page_id: number;
  page_name: string;
  slug: string;
  component: string;
}

/**
 * Tell a status page's subscribers that something changed.
 *
 * Writes a row to status_page_notifications first and keys off the insert
 * failing: a restart, a retried job, or two regions confirming at once must
 * not mail the same announcement twice.
 */
export async function announceIncident(
  monitorId: number,
  incidentId: number,
  event: Event
): Promise<void> {
  let targets: Target[];

  try {
    targets = await query<Target>(
      `SELECT sp.id AS status_page_id, sp.name AS page_name, sp.slug,
              spm.display_name AS component
         FROM status_page_monitors spm
         JOIN status_pages sp ON sp.id = spm.status_page_id
        WHERE spm.monitor_id = $1 AND sp.published = true`,
      [monitorId]
    );
  } catch (error) {
    // An announcement failing must never fail the check that triggered it.
    console.error("Could not look up status pages for announcement:", error);
    return;
  }

  for (const target of targets) {
    try {
      const claimed = await execute(
        `INSERT INTO status_page_notifications (status_page_id, incident_id, event)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [target.status_page_id, incidentId, event]
      );

      if (claimed === 0) continue;

      const subscribers = await query<{ email: string; token: string }>(
        `SELECT email::text AS email, unsubscribe_token_hash AS token
           FROM status_page_subscribers
          WHERE status_page_id = $1 AND confirmed_at IS NOT NULL`,
        [target.status_page_id]
      );

      if (subscribers.length === 0) continue;

      const pageUrl = `${config.appUrl}/status/${target.slug}`;

      const subject =
        event === "opened"
          ? `${target.page_name}: ${target.component} is having problems`
          : `${target.page_name}: ${target.component} is back to normal`;

      const body =
        event === "opened"
          ? `We're investigating an issue affecting <strong>${escapeHtml(target.component)}</strong>.`
          : `<strong>${escapeHtml(target.component)}</strong> is operating normally again.`;

      // One message per subscriber: a shared To: header would leak the whole
      // subscriber list, and each unsubscribe link is individual anyway.
      for (const subscriber of subscribers) {
        try {
          await sendMail({
            from: ALERT_FROM,
            to: subscriber.email,
            subject,
            html: emailLayout(
              subject,
              `
                <p style="font-size:14px;line-height:1.6;color:#333">${body}</p>
                <p style="margin:24px 0">
                  <a href="${pageUrl}"
                     style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:13px;font-weight:500">
                    View status page
                  </a>
                </p>
              `
            ),
          });
        } catch (error) {
          console.error(`Status page email to ${subscriber.email} failed:`, error);
        }
      }
    } catch (error) {
      console.error(`Status page announcement failed for page ${target.status_page_id}:`, error);
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
