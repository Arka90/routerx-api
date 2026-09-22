import { execute, queryOne } from "../../core/db/client";
import { getPlan, UNLIMITED, type PlanId, type PlanLimits } from "./plans";

export interface Subscription {
  org_id: number;
  plan: PlanId;
  status: "active" | "trialing" | "past_due" | "canceled";
  external_customer_id: string | null;
  external_subscription_id: string | null;
  current_period_end: Date | null;
  grandfathered: boolean;
}

export async function getSubscription(orgId: number): Promise<Subscription> {
  const existing = await queryOne<Subscription>(
    `SELECT * FROM subscriptions WHERE org_id = $1`,
    [orgId]
  );

  if (existing) return existing;

  // A workspace created before this table existed, or one whose row was
  // removed: treat it as free and active rather than failing the request.
  await execute(
    `INSERT INTO subscriptions (org_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [orgId]
  );

  return {
    org_id: orgId,
    plan: "free",
    status: "active",
    external_customer_id: null,
    external_subscription_id: null,
    current_period_end: null,
    grandfathered: false,
  };
}

/**
 * The limits actually in force for a workspace.
 *
 * Grandfathered workspaces are unlimited: quotas must never retroactively
 * break a workspace that was created before they existed. A lapsed
 * subscription keeps its plan's limits rather than dropping to free — locking
 * someone out of their own monitoring over a failed card is the wrong
 * response to a failed card.
 */
export async function effectiveLimits(orgId: number): Promise<PlanLimits> {
  const subscription = await getSubscription(orgId);

  if (subscription.grandfathered) return UNLIMITED;

  // A cancelled subscription drops to free at the end of what was paid for.
  // A failed payment does not: locking someone out of their own monitoring
  // over a declined card is the wrong response to a declined card, so
  // past_due keeps the plan's limits while the retries play out.
  if (subscription.status === "canceled") return getPlan("free").limits;

  return getPlan(subscription.plan).limits;
}

export async function setPlan(
  orgId: number,
  plan: PlanId,
  patch: Partial<
    Pick<
      Subscription,
      | "status"
      | "external_customer_id"
      | "external_subscription_id"
      | "current_period_end"
    >
  > = {}
): Promise<void> {
  await execute(
    `INSERT INTO subscriptions
       (org_id, plan, status, external_customer_id, external_subscription_id, current_period_end)
     VALUES ($1, $2, COALESCE($3, 'active'), $4, $5, $6)
     ON CONFLICT (org_id) DO UPDATE SET
       plan = EXCLUDED.plan,
       status = COALESCE(EXCLUDED.status, subscriptions.status),
       external_customer_id = COALESCE(EXCLUDED.external_customer_id, subscriptions.external_customer_id),
       external_subscription_id = COALESCE(EXCLUDED.external_subscription_id, subscriptions.external_subscription_id),
       current_period_end = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end),
       updated_at = now()`,
    [
      orgId,
      plan,
      patch.status ?? null,
      patch.external_customer_id ?? null,
      patch.external_subscription_id ?? null,
      patch.current_period_end ?? null,
    ]
  );
}

export async function findOrgByCustomerId(customerId: string): Promise<number | null> {
  const row = await queryOne<{ org_id: number }>(
    `SELECT org_id FROM subscriptions WHERE external_customer_id = $1`,
    [customerId]
  );

  return row?.org_id ?? null;
}

export interface Usage {
  monitors: number;
  members: number;
  channels: number;
  status_pages: number;
}

export async function getUsage(orgId: number): Promise<Usage> {
  const row = await queryOne<Usage>(
    `SELECT
       (SELECT COUNT(*)::int FROM monitors WHERE org_id = $1) AS monitors,
       (SELECT COUNT(*)::int FROM org_members WHERE org_id = $1) AS members,
       (SELECT COUNT(*)::int FROM notification_channels WHERE org_id = $1) AS channels,
       (SELECT COUNT(*)::int FROM status_pages WHERE org_id = $1) AS status_pages`,
    [orgId]
  );

  return row ?? { monitors: 0, members: 0, channels: 0, status_pages: 0 };
}
