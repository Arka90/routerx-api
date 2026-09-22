import { Request, Response } from "express";
import { z } from "zod";
import { AuthRequest } from "../auth/auth.middleware";
import { config } from "../../core/config";
import { execute, queryOne } from "../../core/db/client";
import { PLANS, getPlan, type PlanId } from "./plans";
import {
  effectiveLimits,
  findOrgByCustomerId,
  getSubscription,
  getUsage,
  setPlan,
} from "./subscription.service";
import {
  createCheckoutSession,
  createPortalSession,
  StripeError,
  verifyWebhookSignature,
} from "./stripe.provider";

const checkoutSchema = z.object({
  plan: z.enum(["pro", "business"]),
});

/** Plan, limits and current usage — shown whether or not billing is wired up. */
export async function getBillingHandler(req: AuthRequest, res: Response) {
  const subscription = await getSubscription(req.orgId!);

  res.json({
    subscription: {
      plan: subscription.plan,
      status: subscription.status,
      current_period_end: subscription.current_period_end,
      grandfathered: subscription.grandfathered,
    },
    limits: await effectiveLimits(req.orgId!),
    usage: await getUsage(req.orgId!),
    // Usage is always reported; it is only refused when this is on.
    enforced: config.enforceQuotas,
    billing_enabled: config.billing.enabled,
    plans: Object.values(PLANS),
  });
}

export async function createCheckoutHandler(req: AuthRequest, res: Response) {
  if (!config.billing.enabled) {
    return res.status(503).json({ error: "Billing is not configured on this instance" });
  }

  const parsed = checkoutSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "Choose a plan to upgrade to" });
  }

  const priceId = config.billing.priceIds[parsed.data.plan];

  if (!priceId) {
    return res
      .status(503)
      .json({ error: `No price is configured for the ${parsed.data.plan} plan` });
  }

  const subscription = await getSubscription(req.orgId!);

  try {
    const session = await createCheckoutSession({
      orgId: req.orgId!,
      plan: parsed.data.plan,
      priceId,
      customerEmail: req.user!.email,
      customerId: subscription.external_customer_id,
      successUrl: `${config.appUrl}/settings/billing?upgraded=1`,
      cancelUrl: `${config.appUrl}/settings/billing`,
    });

    res.json({ url: session.url });
  } catch (error) {
    if (error instanceof StripeError) {
      console.error("Stripe checkout failed:", error.message);
      return res.status(502).json({ error: "Could not start checkout. Please try again." });
    }
    throw error;
  }
}

export async function createPortalHandler(req: AuthRequest, res: Response) {
  if (!config.billing.enabled) {
    return res.status(503).json({ error: "Billing is not configured on this instance" });
  }

  const subscription = await getSubscription(req.orgId!);

  if (!subscription.external_customer_id) {
    return res.status(400).json({ error: "This workspace has no billing account yet" });
  }

  try {
    const session = await createPortalSession(
      subscription.external_customer_id,
      `${config.appUrl}/settings/billing`
    );

    res.json({ url: session.url });
  } catch (error) {
    if (error instanceof StripeError) {
      console.error("Stripe portal failed:", error.message);
      return res.status(502).json({ error: "Could not open the billing portal." });
    }
    throw error;
  }
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function planFromMetadata(object: Record<string, unknown>): PlanId | null {
  const metadata = object.metadata as Record<string, unknown> | undefined;
  const plan = asString(metadata?.plan);

  return plan && plan in PLANS ? (plan as PlanId) : null;
}

function orgFromMetadata(object: Record<string, unknown>): number | null {
  const metadata = object.metadata as Record<string, unknown> | undefined;
  const orgId = Number(asString(metadata?.org_id));

  return Number.isInteger(orgId) && orgId > 0 ? orgId : null;
}

/**
 * Stripe webhook.
 *
 * Mounted before the JSON body parser so the raw bytes survive — the
 * signature covers the exact payload Stripe sent, and re-serialising it
 * would reorder keys and fail every check.
 */
export async function webhookHandler(req: Request, res: Response) {
  const raw = req.body as Buffer;

  if (
    !verifyWebhookSignature(
      raw,
      req.headers["stripe-signature"] as string | undefined,
      config.billing.stripeWebhookSecret
    )
  ) {
    return res.status(400).json({ error: "Invalid signature" });
  }

  let event: StripeEvent;

  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid payload" });
  }

  // Stripe retries aggressively and can deliver out of order, so the handler
  // has to be idempotent. Claiming the id is how we make it so.
  const claimed = await execute(
    `INSERT INTO billing_events (id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [event.id, event.type]
  );

  if (claimed === 0) {
    return res.json({ received: true, duplicate: true });
  }

  try {
    await handleEvent(event);
  } catch (error) {
    console.error(`Billing webhook ${event.type} failed:`, error);

    // Let the id be claimed again so Stripe's retry can have another go.
    await execute(`DELETE FROM billing_events WHERE id = $1`, [event.id]);

    return res.status(500).json({ error: "Could not process event" });
  }

  res.json({ received: true });
}

async function handleEvent(event: StripeEvent): Promise<void> {
  const object = event.data.object;

  switch (event.type) {
    case "checkout.session.completed": {
      const orgId = orgFromMetadata(object);
      const plan = planFromMetadata(object);

      if (!orgId || !plan) {
        console.warn(`checkout.session.completed ${event.id} had no org metadata`);
        return;
      }

      await setPlan(orgId, plan, {
        status: "active",
        external_customer_id: asString(object.customer),
        external_subscription_id: asString(object.subscription),
      });
      return;
    }

    case "customer.subscription.updated":
    case "customer.subscription.created": {
      const orgId =
        orgFromMetadata(object) ??
        (await findOrgByCustomerId(asString(object.customer) ?? ""));

      if (!orgId) return;

      const plan = planFromMetadata(object) ?? (await getSubscription(orgId)).plan;
      const status = asString(object.status);
      const periodEnd = Number(object.current_period_end);

      await setPlan(orgId, plan, {
        status:
          status === "past_due" || status === "unpaid"
            ? "past_due"
            : status === "trialing"
            ? "trialing"
            : status === "canceled"
            ? "canceled"
            : "active",
        external_customer_id: asString(object.customer),
        external_subscription_id: asString(object.id),
        current_period_end: Number.isFinite(periodEnd)
          ? new Date(periodEnd * 1000)
          : null,
      });
      return;
    }

    case "customer.subscription.deleted": {
      const orgId =
        orgFromMetadata(object) ??
        (await findOrgByCustomerId(asString(object.customer) ?? ""));

      if (!orgId) return;

      // Keep the plan recorded for history; effectiveLimits drops a canceled
      // workspace to free.
      await setPlan(orgId, (await getSubscription(orgId)).plan, { status: "canceled" });
      return;
    }

    default:
      // Everything else is acknowledged and ignored; Stripe sends a lot.
      return;
  }
}

/** Plans are public information — the pricing page needs them signed out. */
export async function listPlansHandler(_req: Request, res: Response) {
  res.json({ plans: Object.values(PLANS), billing_enabled: config.billing.enabled });
}

export { getPlan };

/** Exposed for the settings page so it can warn before a limit bites. */
export async function quotaSummary(orgId: number) {
  return {
    limits: await effectiveLimits(orgId),
    usage: await getUsage(orgId),
  };
}

export async function orgExists(orgId: number): Promise<boolean> {
  return Boolean(
    await queryOne<{ id: number }>(`SELECT id FROM organizations WHERE id = $1`, [orgId])
  );
}
