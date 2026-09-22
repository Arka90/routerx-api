import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import { verifyWebhookSignature } from "../modules/billing/stripe.provider";
import { PLANS } from "../modules/billing/plans";
import {
  effectiveLimits,
  getSubscription,
  getUsage,
  setPlan,
} from "../modules/billing/subscription.service";
import {
  assertIntervalAllowed,
  assertRegionsAllowed,
  assertWithinQuota,
  QuotaExceededError,
} from "../modules/billing/quota";
import { config } from "../core/config";
import { createMonitor, createUserAndOrg, execute, resetDatabase } from "./helpers/db";

/**
 * New workspaces have no subscription row until something asks for one, so
 * flipping the flag has to upsert rather than update.
 */
async function grandfather(orgId: number): Promise<void> {
  await execute(
    `INSERT INTO subscriptions (org_id, grandfathered) VALUES ($1, true)
     ON CONFLICT (org_id) DO UPDATE SET grandfathered = true`,
    [orgId]
  );
}

const SECRET = "whsec_test_secret";

function sign(payload: string, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");

  return `t=${timestamp},v1=${signature}`;
}

describe("webhook signatures", () => {
  const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });

  it("accepts a correctly signed payload", () => {
    expect(verifyWebhookSignature(payload, sign(payload), SECRET)).toBe(true);
  });

  it("accepts a Buffer body, which is what the route actually receives", () => {
    const raw = Buffer.from(payload, "utf8");
    expect(verifyWebhookSignature(raw, sign(payload), SECRET)).toBe(true);
  });

  it("rejects a payload signed with a different secret", () => {
    expect(verifyWebhookSignature(payload, sign(payload, "whsec_wrong"), SECRET)).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const header = sign(payload);
    expect(verifyWebhookSignature(`${payload} `, header, SECRET)).toBe(false);
  });

  it("rejects a replayed signature outside the tolerance window", () => {
    const stale = Math.floor(Date.now() / 1000) - 3600;
    expect(verifyWebhookSignature(payload, sign(payload, SECRET, stale), SECRET)).toBe(false);
  });

  it("accepts one valid signature among several, as Stripe sends during rotation", () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const good = crypto
      .createHmac("sha256", SECRET)
      .update(`${timestamp}.${payload}`)
      .digest("hex");

    const header = `t=${timestamp},v1=${"0".repeat(64)},v1=${good}`;

    expect(verifyWebhookSignature(payload, header, SECRET)).toBe(true);
  });

  it("rejects missing, malformed, or unsigned input", () => {
    expect(verifyWebhookSignature(payload, undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature(payload, "nonsense", SECRET)).toBe(false);
    expect(verifyWebhookSignature(payload, sign(payload), "")).toBe(false);
  });
});

describe("plan limits", () => {
  let orgId: number;

  beforeEach(async () => {
    await resetDatabase();
    ({ orgId } = await createUserAndOrg());
  });

  it("gives a new workspace the free plan", async () => {
    const subscription = await getSubscription(orgId);

    expect(subscription.plan).toBe("free");
    expect(subscription.status).toBe("active");
  });

  it("applies the plan's limits once upgraded", async () => {
    await setPlan(orgId, "pro");

    expect(await effectiveLimits(orgId)).toEqual(PLANS.pro.limits);
  });

  it("keeps the plan's limits while a payment is being retried", async () => {
    await setPlan(orgId, "pro", { status: "past_due" });

    // Locking someone out of their own monitoring over a declined card is the
    // wrong response to a declined card.
    expect(await effectiveLimits(orgId)).toEqual(PLANS.pro.limits);
  });

  it("drops to free once a subscription is cancelled", async () => {
    await setPlan(orgId, "pro", { status: "canceled" });

    expect(await effectiveLimits(orgId)).toEqual(PLANS.free.limits);
  });

  it("gives a grandfathered workspace no limits at all", async () => {
    await grandfather(orgId);

    const limits = await effectiveLimits(orgId);

    expect(limits.monitors).toBeNull();
    expect(limits.members).toBeNull();
  });

  it("counts what a workspace is using", async () => {
    await createMonitor(orgId);
    await createMonitor(orgId);

    const usage = await getUsage(orgId);

    expect(usage.monitors).toBe(2);
    expect(usage.members).toBe(1);
  });
});

describe("quota enforcement", () => {
  let orgId: number;

  beforeEach(async () => {
    await resetDatabase();
    ({ orgId } = await createUserAndOrg());
  });

  afterEach(() => {
    vi.spyOn(config, "enforceQuotas", "get").mockRestore?.();
  });

  function enforce(enabled: boolean) {
    Object.defineProperty(config, "enforceQuotas", {
      value: enabled,
      configurable: true,
      writable: true,
    });
  }

  it("allows everything while enforcement is off", async () => {
    enforce(false);

    for (let i = 0; i < PLANS.free.limits.monitors! + 3; i++) {
      await createMonitor(orgId);
    }

    await expect(assertWithinQuota(orgId, "monitors")).resolves.toBeUndefined();
    await expect(assertIntervalAllowed(orgId, 30)).resolves.toBeUndefined();
  });

  it("refuses one monitor past the plan's limit", async () => {
    enforce(true);

    for (let i = 0; i < PLANS.free.limits.monitors!; i++) {
      await createMonitor(orgId);
    }

    await expect(assertWithinQuota(orgId, "monitors")).rejects.toBeInstanceOf(
      QuotaExceededError
    );
  });

  it("allows the last slot up to the limit", async () => {
    enforce(true);

    for (let i = 0; i < PLANS.free.limits.monitors! - 1; i++) {
      await createMonitor(orgId);
    }

    await expect(assertWithinQuota(orgId, "monitors")).resolves.toBeUndefined();
  });

  it("refuses an interval faster than the plan allows", async () => {
    enforce(true);

    await expect(assertIntervalAllowed(orgId, 30)).rejects.toBeInstanceOf(QuotaExceededError);
    await expect(
      assertIntervalAllowed(orgId, PLANS.free.limits.minIntervalSeconds)
    ).resolves.toBeUndefined();
  });

  it("refuses more regions than the plan allows", async () => {
    enforce(true);

    await expect(assertRegionsAllowed(orgId, 3)).rejects.toBeInstanceOf(QuotaExceededError);
    await expect(assertRegionsAllowed(orgId, 1)).resolves.toBeUndefined();
  });

  it("never refuses a grandfathered workspace", async () => {
    enforce(true);
    await grandfather(orgId);

    for (let i = 0; i < PLANS.free.limits.monitors! + 2; i++) {
      await createMonitor(orgId);
    }

    await expect(assertWithinQuota(orgId, "monitors")).resolves.toBeUndefined();
    await expect(assertIntervalAllowed(orgId, 30)).resolves.toBeUndefined();
  });
});
