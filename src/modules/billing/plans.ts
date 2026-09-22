export type PlanId = "free" | "pro" | "business";

export interface PlanLimits {
  /** null means no limit. */
  monitors: number | null;
  members: number | null;
  channels: number | null;
  statusPages: number | null;
  /** How many vantage points a monitor may be checked from. */
  regions: number | null;
  /** The fastest check interval this plan allows, in seconds. */
  minIntervalSeconds: number;
  /** How long probe history is kept. */
  retentionDays: number;
}

export interface Plan {
  id: PlanId;
  name: string;
  /** In minor units (cents), per month. */
  priceMonthly: number;
  limits: PlanLimits;
  blurb: string;
}

/**
 * Limits live in code, not in the database.
 *
 * A plan's shape is a product decision that ships with a release and needs to
 * be reviewable in a diff; only which plan a workspace is on belongs in a
 * row. Changing a limit here changes it for every workspace on that plan, at
 * deploy time, with no data migration.
 */
export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    priceMonthly: 0,
    blurb: "Enough to watch a side project properly.",
    limits: {
      monitors: 5,
      members: 2,
      channels: 2,
      statusPages: 1,
      regions: 1,
      minIntervalSeconds: 300,
      retentionDays: 7,
    },
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceMonthly: 1900,
    blurb: "For a team that gets paged.",
    limits: {
      monitors: 50,
      members: 10,
      channels: 10,
      statusPages: 5,
      regions: 3,
      minIntervalSeconds: 60,
      retentionDays: 30,
    },
  },
  business: {
    id: "business",
    name: "Business",
    priceMonthly: 9900,
    blurb: "Multi-region confirmation and a long memory.",
    limits: {
      monitors: 250,
      members: null,
      channels: null,
      statusPages: 20,
      regions: null,
      minIntervalSeconds: 30,
      retentionDays: 90,
    },
  },
};

export const PLAN_IDS = Object.keys(PLANS) as PlanId[];

export function getPlan(id: string): Plan {
  return PLANS[id as PlanId] ?? PLANS.free;
}

/**
 * A workspace that predates plan limits, or one whose payment has lapsed but
 * whose data we are not going to hold hostage, gets unlimited everything.
 */
export const UNLIMITED: PlanLimits = {
  monitors: null,
  members: null,
  channels: null,
  statusPages: null,
  regions: null,
  minIntervalSeconds: 30,
  retentionDays: 90,
};
