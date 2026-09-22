import { execute, query } from "../../core/db/client";
import { config } from "../../core/config";
import {
  ALERT_FROM,
  emailButton,
  emailLayout,
  emailParagraph,
  emailPill,
  emailTable,
  escapeHtml,
  sendMail,
} from "../../core/mail/mailer";

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

      const opened = event === "opened";

      const html = emailLayout(
        opened
          ? `${escapeHtml(target.component)} is having problems`
          : `${escapeHtml(target.component)} is back to normal`,
        emailParagraph(
          opened
            ? `We're investigating an issue affecting <strong>${escapeHtml(target.component)}</strong>. Updates will be posted on the status page as we learn more.`
            : `<strong>${escapeHtml(target.component)}</strong> is operating normally again. Thanks for your patience.`
        ) +
          emailTable(
            [
              { label: "Component", value: escapeHtml(target.component) },
              {
                label: "Status",
                value: emailPill(opened ? "Investigating" : "Resolved", opened ? "down" : "up"),
              },
              { label: "Status page", value: escapeHtml(target.page_name) },
            ],
            { tone: opened ? "down" : "up" }
          ) +
          emailButton(pageUrl, "View status page"),
        {
          eyebrow: "Status update",
          tone: opened ? "down" : "up",
          preheader: opened
            ? `${target.component} is having problems. We're investigating.`
            : `${target.component} is operating normally again.`,
          footerNote: `You subscribed to updates from ${escapeHtml(target.page_name)}. Every message includes an unsubscribe link in the status page footer.`,
        }
      );

      // One message per subscriber: a shared To: header would leak the whole
      // subscriber list, and each unsubscribe link is individual anyway.
      for (const subscriber of subscribers) {
        try {
          await sendMail({
            from: ALERT_FROM,
            to: subscriber.email,
            subject,
            html,
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
