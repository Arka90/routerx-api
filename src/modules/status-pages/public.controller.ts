import { Request, Response } from "express";
import { z } from "zod";
import { queryOne } from "../../core/db/client";
import { config } from "../../core/config";
import {
  emailButton,
  emailLayout,
  emailLink,
  emailParagraph,
  escapeHtml,
  sendMail,
} from "../../core/mail/mailer";
import { buildPublicStatusPage } from "./public-view.service";
import {
  confirmSubscription,
  requestSubscription,
  unsubscribe,
} from "./status-page.service";

const subscribeSchema = z.object({
  email: z.string().trim().email().max(254),
});

export async function viewStatusPage(req: Request, res: Response) {
  const slug = String(req.params.slug ?? "").toLowerCase();

  const page = await buildPublicStatusPage(slug);

  if (!page) {
    return res.status(404).json({ error: "Status page not found" });
  }

  // Cheap to regenerate and read far more often than it changes, but stale
  // data on a status page is worse than a slow one — hence the short window.
  res.setHeader("Cache-Control", "public, max-age=30");

  res.json(page);
}

export async function subscribeHandler(req: Request, res: Response) {
  const slug = String(req.params.slug ?? "").toLowerCase();
  const parsed = subscribeSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "A valid email address is required" });
  }

  const page = await queryOne<{ id: number; name: string }>(
    `SELECT id, name FROM status_pages WHERE slug = $1 AND published = true`,
    [slug]
  );

  if (!page) {
    return res.status(404).json({ error: "Status page not found" });
  }

  const subscription = await requestSubscription(page.id, parsed.data.email);

  // Already-confirmed addresses are silently not re-mailed, and the response
  // below is identical either way: otherwise this endpoint becomes a way to
  // test which addresses follow a given company's status page.
  if (!subscription.alreadyConfirmed) {
    const confirmUrl = `${config.appUrl}/status/confirm/${subscription.confirmToken}`;
    const unsubscribeUrl = `${config.appUrl}/status/unsubscribe/${subscription.unsubscribeToken}`;

    try {
      await sendMail({
        to: parsed.data.email,
        subject: `Confirm your subscription to ${page.name}`,
        html: emailLayout(
          "Confirm your subscription",
          emailParagraph(
            `Confirm that you'd like an email when <strong>${escapeHtml(page.name)}</strong>
             has an incident, and another when it's resolved.`
          ) +
            emailButton(confirmUrl, "Confirm subscription") +
            emailParagraph(
              `If you didn't request this, ignore this email — nothing will be sent.
               Not you? ${emailLink(unsubscribeUrl, "Remove this address")}.`,
              { muted: true }
            ),
          {
            eyebrow: "Subscription",
            preheader: `One click to get incident updates from ${page.name}.`,
            footerNote: `Sent because this address was entered on the ${escapeHtml(page.name)} status page.`,
          }
        ),
      });
    } catch (error) {
      console.error("Could not send subscription confirmation:", error);
      return res
        .status(502)
        .json({ error: "Could not send the confirmation email. Please try again." });
    }
  }

  res.json({ message: "Check your email to confirm the subscription." });
}

export async function confirmHandler(req: Request, res: Response) {
  const email = await confirmSubscription(String(req.params.token ?? ""));

  if (!email) {
    return res
      .status(404)
      .json({ error: "That confirmation link is invalid or has already been used" });
  }

  res.json({ message: "Subscription confirmed", email });
}

export async function unsubscribeHandler(req: Request, res: Response) {
  const removed = await unsubscribe(String(req.params.token ?? ""));

  if (!removed) {
    return res.status(404).json({ error: "That link is invalid or already used" });
  }

  res.json({ message: "Unsubscribed" });
}
