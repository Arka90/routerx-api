import { describe, it, expect, beforeEach, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn().mockResolvedValue(undefined) }));

// Every channel type resolves to the same stub, so these tests are about
// routing and bookkeeping rather than payload shape.
vi.mock("../modules/notifications/registry", () => ({
  getProvider: () => ({ type: "email", send, validateConfig: async (c: unknown) => c }),
  CHANNEL_TYPES: ["email", "slack", "discord", "webhook"],
}));

import { dispatchAlert } from "../modules/notifications/notifier";
import {
  createMonitor,
  createUserAndOrg,
  execute,
  query,
  queryOne,
  resetDatabase,
} from "./helpers/db";

async function addChannel(orgId: number, name: string, enabled = true): Promise<number> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO notification_channels (org_id, type, name, config, enabled)
     VALUES ($1, 'email', $2, '{}'::jsonb, $3) RETURNING id`,
    [orgId, name, enabled]
  );
  return row!.id;
}

describe("alert routing", () => {
  let orgId: number;
  let monitorId: number;

  beforeEach(async () => {
    await resetDatabase();
    ({ orgId } = await createUserAndOrg());
    monitorId = await createMonitor(orgId);
    send.mockClear();
    send.mockResolvedValue(undefined);
  });

  const params = () => ({
    orgId,
    organizationName: "Acme",
    monitor: { id: monitorId, name: null, url: "https://example.com" },
    type: "DOWN" as const,
    headline: "Down",
  });

  it("falls back to every enabled channel in the workspace when none are linked", async () => {
    await addChannel(orgId, "one");
    await addChannel(orgId, "two");

    await dispatchAlert(params());

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("uses only the linked channels once a monitor has them", async () => {
    const linked = await addChannel(orgId, "linked");
    await addChannel(orgId, "unlinked");

    await execute(
      `INSERT INTO monitor_channels (monitor_id, channel_id) VALUES ($1, $2)`,
      [monitorId, linked]
    );

    await dispatchAlert(params());

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("skips disabled channels", async () => {
    await addChannel(orgId, "on", true);
    await addChannel(orgId, "off", false);

    await dispatchAlert(params());

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never routes to another workspace's channels", async () => {
    const other = await createUserAndOrg("other@example.com", "Other workspace");
    await addChannel(other.orgId, "theirs");
    await addChannel(orgId, "ours");

    await dispatchAlert(params());

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps going when one channel throws", async () => {
    await addChannel(orgId, "broken");
    await addChannel(orgId, "working");

    send.mockRejectedValueOnce(new Error("webhook returned 404"));

    await dispatchAlert(params());

    expect(send).toHaveBeenCalledTimes(2);

    const deliveries = await query<{ status: string; error: string | null }>(
      `SELECT status, error FROM alert_deliveries ORDER BY status`
    );

    expect(deliveries.map((d) => d.status).sort()).toEqual(["failed", "sent"]);
    expect(deliveries.find((d) => d.status === "failed")?.error).toContain("404");
  });

  it("records a delivery row per channel", async () => {
    await addChannel(orgId, "one");
    await addChannel(orgId, "two");

    await dispatchAlert(params());

    const deliveries = await query(`SELECT id FROM alert_deliveries`);
    expect(deliveries).toHaveLength(2);
  });

  it("does not throw when the workspace has no channels at all", async () => {
    await expect(dispatchAlert(params())).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});
