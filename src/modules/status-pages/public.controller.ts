import { Request, Response } from "express";
import { z } from "zod";
import { queryOne } from "../../core/db/client";
import { config } from "../../core/config";
import { emailLayout, sendMail } from "../../core/mail/mailer";
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

    try {
      await sendMail({
        to: parsed.data.email,
        subject: `Confirm your subscription to ${page.name}`,
        html: emailLayout(
          `Confirm your subscription`,
          `
            <p style="font-size:14px;line-height:1.6;color:#333">
              Confirm that you'd like updates when <strong>${escapeHtml(page.name)}</strong>
              has an incident.
            </p>
            <p style="margin:24px 0">
              <a href="${confirmUrl}"
                 style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:13px;font-weight:500">
                Confirm subscription
              </a>
            </p>
            <p style="font-size:13px;color:#666">
              If you didn't request this, ignore this email — nothing will be sent.
            </p>
          `
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
