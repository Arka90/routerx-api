import { config } from "../../core/config";
import { effectiveLimits, getUsage } from "./subscription.service";
import type { PlanLimits } from "./plans";

export class QuotaExceededError extends Error {
  constructor(message: string, readonly limit: number, readonly used: number) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

type Countable = "monitors" | "members" | "channels" | "status_pages";

const LIMIT_KEY: Record<Countable, keyof PlanLimits> = {
  monitors: "monitors",
  members: "members",
  channels: "channels",
  status_pages: "statusPages",
};

const NOUN: Record<Countable, string> = {
  monitors: "monitor",
  members: "team member",
  channels: "alert channel",
  status_pages: "status page",
};

/**
 * Refuse to create one more of `resource` when the plan is already at its
 * limit.
 *
 * Enforcement is behind ENFORCE_QUOTAS, off by default. Turning limits on for
 * an existing deployment silently, in the same release that introduces them,
 * would break workspaces that did nothing wrong. Usage is always reported
 * either way, so the numbers can be looked at before the switch is flipped.
 */
export async function assertWithinQuota(
  orgId: number,
  resource: Countable
): Promise<void> {
  if (!config.enforceQuotas) return;

  const limits = await effectiveLimits(orgId);
  const limit = limits[LIMIT_KEY[resource]] as number | null;

  if (limit === null) return;

  const usage = await getUsage(orgId);
  const used = usage[resource];

  if (used >= limit) {
    throw new QuotaExceededError(
      `Your plan includes ${limit} ${NOUN[resource]}${limit === 1 ? "" : "s"}. ` +
        `Upgrade to add more.`,
      limit,
      used
    );
  }
}

/**
 * The floor on check frequency. This is the limit that actually protects the
 * bill: a hundred free monitors at 30 seconds is 288,000 outbound checks a
 * day, most of them pointed at someone else's server.
 */
export async function assertIntervalAllowed(
  orgId: number,
  intervalSeconds: number
): Promise<void> {
  if (!config.enforceQuotas) return;

  const limits = await effectiveLimits(orgId);

  if (intervalSeconds < limits.minIntervalSeconds) {
    throw new QuotaExceededError(
      `Your plan checks at most every ${limits.minIntervalSeconds} seconds. ` +
        `Upgrade for faster checks.`,
      limits.minIntervalSeconds,
      intervalSeconds
    );
  }
}

export async function assertRegionsAllowed(
  orgId: number,
  regionCount: number
): Promise<void> {
  if (!config.enforceQuotas || regionCount <= 1) return;

  const limits = await effectiveLimits(orgId);

  if (limits.regions !== null && regionCount > limits.regions) {
    throw new QuotaExceededError(
      `Your plan checks from ${limits.regions} region${limits.regions === 1 ? "" : "s"}. ` +
        `Upgrade to probe from more.`,
      limits.regions,
      regionCount
    );
  }
}
