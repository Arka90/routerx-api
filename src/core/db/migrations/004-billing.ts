/**
 * Plans and quotas.
 *
 * Unlimited 30-second monitors per free signup is unbounded egress cost and
 * makes the service a plausible amplifier for someone else's bad day. Limits
 * are defined in code (src/modules/billing/plans.ts); this table records
 * which one a workspace is on.
 */
export const up = `
CREATE TABLE subscriptions (
  org_id                    BIGINT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan                      TEXT NOT NULL DEFAULT 'free',
  status                    TEXT NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'trialing', 'past_due', 'canceled')),
  external_customer_id      TEXT,
  external_subscription_id  TEXT,
  current_period_end        TIMESTAMPTZ,
  -- Workspaces that predate plan limits keep working regardless of what the
  -- plan says. Cleared deliberately, never automatically.
  grandfathered             BOOLEAN NOT NULL DEFAULT false,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_subscriptions_external_customer
  ON subscriptions(external_customer_id) WHERE external_customer_id IS NOT NULL;

-- Every existing workspace is grandfathered: quotas must never retroactively
-- break a workspace that was created before they existed.
INSERT INTO subscriptions (org_id, plan, grandfathered)
SELECT id, 'free', true FROM organizations;

-- Processed billing webhook ids. Providers retry aggressively and deliver out
-- of order, so the handler has to be idempotent.
CREATE TABLE billing_events (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
