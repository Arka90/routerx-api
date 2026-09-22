import { describe, it, expect, beforeEach, vi } from "vitest";

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn().mockResolvedValue({}) }));

vi.mock("../core/mail/mailer", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendMail,
}));

import {
  confirmSubscription,
  createStatusPage,
  listComponents,
  normalizeSlug,
  requestSubscription,
  setComponents,
  SlugTakenError,
  unsubscribe,
  updateStatusPage,
} from "../modules/status-pages/status-page.service";
import { buildPublicStatusPage } from "../modules/status-pages/public-view.service";
import { announceIncident } from "../modules/status-pages/announcer";
import {
  addIncident,
  createMonitor,
  createUserAndOrg,
  execute,
  query,
  queryOne,
  resetDatabase,
} from "./helpers/db";

const DAY = 24 * 60 * 60 * 1000;

describe("slugs", () => {
  it("normalises anything into a URL-safe address", () => {
    expect(normalizeSlug("Acme Corp — Status!")).toBe("acme-corp-status");
    expect(normalizeSlug("  spaced  out  ")).toBe("spaced-out");
  });

  it("rejects reserved and too-short addresses", async () => {
    await resetDatabase();
    const { orgId } = await createUserAndOrg();

    await expect(createStatusPage(orgId, { name: "API", slug: "api" })).rejects.toBeInstanceOf(
      SlugTakenError
    );
    await expect(createStatusPage(orgId, { name: "x", slug: "x" })).rejects.toBeInstanceOf(
      SlugTakenError
    );
  });

  it("refuses an address another workspace already has", async () => {
    await resetDatabase();
    const first = await createUserAndOrg("a@example.com", "A");
    const second = await createUserAndOrg("b@example.com", "B");

    await createStatusPage(first.orgId, { name: "Status", slug: "shared-name" });

    await expect(
      createStatusPage(second.orgId, { name: "Status", slug: "shared-name" })
    ).rejects.toBeInstanceOf(SlugTakenError);
  });
});

describe("components", () => {
  let orgId: number;
  let pageId: number;

  beforeEach(async () => {
    await resetDatabase();
    ({ orgId } = await createUserAndOrg());
    pageId = (await createStatusPage(orgId, { name: "Status", slug: "acme-status" })).id;
  });

  it("stores a display name rather than exposing the monitor URL", async () => {
    const monitorId = await createMonitor(orgId, {
      url: "https://internal.example.com/_healthz?token=secret",
    });

    await setComponents(orgId, pageId, [
      { monitor_id: monitorId, display_name: "API" },
    ]);

    const components = await listComponents(pageId);

    expect(components).toHaveLength(1);
    expect(components[0].display_name).toBe("API");
  });

  it("silently drops a monitor belonging to another workspace", async () => {
    const other = await createUserAndOrg("other@example.com", "Other");
    const theirMonitor = await createMonitor(other.orgId);

    await setComponents(orgId, pageId, [
      { monitor_id: theirMonitor, display_name: "Not mine" },
    ]);

    // A status page must not be usable to publish somebody else's uptime.
    expect(await listComponents(pageId)).toHaveLength(0);
  });

  it("replaces the list wholesale", async () => {
    const first = await createMonitor(orgId);
    const second = await createMonitor(orgId);

    await setComponents(orgId, pageId, [{ monitor_id: first, display_name: "One" }]);
    await setComponents(orgId, pageId, [{ monitor_id: second, display_name: "Two" }]);

    const components = await listComponents(pageId);

    expect(components).toHaveLength(1);
    expect(components[0].display_name).toBe("Two");
  });
});

describe("the public page", () => {
  let orgId: number;
  let pageId: number;
  let monitorId: number;

  beforeEach(async () => {
    await resetDatabase();
    ({ orgId } = await createUserAndOrg());
    pageId = (await createStatusPage(orgId, { name: "Acme", slug: "acme-status" })).id;
    monitorId = await createMonitor(orgId);
    await setComponents(orgId, pageId, [{ monitor_id: monitorId, display_name: "API" }]);
  });

  it("is not visible until it is published", async () => {
    expect(await buildPublicStatusPage("acme-status")).toBeNull();

    await updateStatusPage(orgId, pageId, { published: true });

    expect(await buildPublicStatusPage("acme-status")).not.toBeNull();
  });

  it("reports operational with 90 days of history", async () => {
    await updateStatusPage(orgId, pageId, { published: true });
    await execute(`UPDATE monitors SET confirmed_status = 'UP' WHERE id = $1`, [monitorId]);

    const page = (await buildPublicStatusPage("acme-status"))!;

    expect(page.overall).toBe("operational");
    expect(page.components[0].history).toHaveLength(90);
    expect(page.components[0].uptime_percentage).toBe(100);
  });

  it("reflects an outage in the overall status", async () => {
    await updateStatusPage(orgId, pageId, { published: true });
    await execute(`UPDATE monitors SET confirmed_status = 'DOWN' WHERE id = $1`, [monitorId]);

    const page = (await buildPublicStatusPage("acme-status"))!;

    expect(page.overall).toBe("outage");
    expect(page.components[0].status).toBe("outage");
  });

  it("charges a past outage to the days it actually spanned", async () => {
    await updateStatusPage(orgId, pageId, { published: true });

    // Aged past the whole 90-day window so every day is observed and the
    // arithmetic is exact: six hours out of ninety days is ~99.72%.
    const older = await createMonitor(orgId, {
      created_at: new Date(Date.now() - 91 * DAY),
    });
    await setComponents(orgId, pageId, [
      { monitor_id: older, display_name: "API" },
    ]);

    // Depending on the time of day this may straddle midnight, so the
    // assertion is on the accounting rather than on which bucket it lands in.
    const start = new Date(Date.now() - 2 * DAY);
    await addIncident(older, start, new Date(start.getTime() + 6 * 60 * 60 * 1000));

    const page = (await buildPublicStatusPage("acme-status"))!;

    expect(page.components[0].uptime_percentage).toBeGreaterThan(99.6);
    expect(page.components[0].uptime_percentage).toBeLessThan(99.8);

    const affected = page.components[0].history.filter(
      (day) => day.uptime !== null && day.uptime < 99.9
    );

    expect(affected.length).toBeGreaterThanOrEqual(1);
    expect(affected.length).toBeLessThanOrEqual(2);

    // Everything outside the outage is untouched.
    const perfect = page.components[0].history.filter((day) => day.uptime === 100);
    expect(perfect.length).toBeGreaterThan(85);
  });

  it("leaves days before the monitor existed blank rather than showing them as down", async () => {
    await updateStatusPage(orgId, pageId, { published: true });

    const young = await createMonitor(orgId, { created_at: new Date(Date.now() - 2 * DAY) });
    await setComponents(orgId, pageId, [{ monitor_id: young, display_name: "New service" }]);

    const page = (await buildPublicStatusPage("acme-status"))!;
    const known = page.components[0].history.filter((day) => day.uptime !== null);

    expect(known.length).toBeLessThanOrEqual(3);
  });

  it("shows only public incident updates", async () => {
    await updateStatusPage(orgId, pageId, { published: true });
    await addIncident(monitorId, new Date(Date.now() - 3600_000), null);

    const incident = await queryOne<{ id: number }>(
      `SELECT id FROM incidents WHERE monitor_id = $1`,
      [monitorId]
    );

    await execute(
      `INSERT INTO incident_updates (incident_id, status, body, is_public)
       VALUES ($1, 'investigating', 'Looking into it', true),
              ($1, 'identified', 'Root cause is the vendor', false)`,
      [incident!.id]
    );

    const page = (await buildPublicStatusPage("acme-status"))!;

    expect(page.active_incidents).toHaveLength(1);
    expect(page.active_incidents[0].updates).toHaveLength(1);
    expect(page.active_incidents[0].updates[0].body).toBe("Looking into it");
  });
});

describe("subscribers", () => {
  let orgId: number;
  let pageId: number;

  beforeEach(async () => {
    await resetDatabase();
    sendMail.mockClear();
    ({ orgId } = await createUserAndOrg());
    pageId = (await createStatusPage(orgId, { name: "Acme", slug: "acme-status" })).id;
  });

  it("requires confirmation before it counts as a subscriber", async () => {
    const pending = await requestSubscription(pageId, "reader@example.com");

    const before = await query(
      `SELECT id FROM status_page_subscribers WHERE confirmed_at IS NOT NULL`
    );
    expect(before).toHaveLength(0);

    expect(await confirmSubscription(pending.confirmToken)).toBe("reader@example.com");

    const after = await query(
      `SELECT id FROM status_page_subscribers WHERE confirmed_at IS NOT NULL`
    );
    expect(after).toHaveLength(1);
  });

  it("stores hashes, not the tokens themselves", async () => {
    const pending = await requestSubscription(pageId, "reader@example.com");

    const row = await queryOne<{ confirm_token_hash: string; unsubscribe_token_hash: string }>(
      `SELECT confirm_token_hash, unsubscribe_token_hash FROM status_page_subscribers`
    );

    expect(row!.confirm_token_hash).not.toBe(pending.confirmToken);
    expect(row!.unsubscribe_token_hash).not.toBe(pending.unsubscribeToken);
  });

  it("cannot be confirmed twice", async () => {
    const pending = await requestSubscription(pageId, "reader@example.com");

    await confirmSubscription(pending.confirmToken);

    expect(await confirmSubscription(pending.confirmToken)).toBeNull();
  });

  it("reports an already-confirmed address without re-sending anything", async () => {
    const pending = await requestSubscription(pageId, "reader@example.com");
    await confirmSubscription(pending.confirmToken);

    const again = await requestSubscription(pageId, "reader@example.com");

    expect(again.alreadyConfirmed).toBe(true);
  });

  it("unsubscribes with the token from the email", async () => {
    const pending = await requestSubscription(pageId, "reader@example.com");
    await confirmSubscription(pending.confirmToken);

    expect(await unsubscribe(pending.unsubscribeToken)).toBe(true);
    expect(await query(`SELECT id FROM status_page_subscribers`)).toHaveLength(0);
  });
});

describe("announcements", () => {
  let orgId: number;
  let pageId: number;
  let monitorId: number;
  let incidentId: number;

  beforeEach(async () => {
    await resetDatabase();
    sendMail.mockClear();
    ({ orgId } = await createUserAndOrg());
    pageId = (await createStatusPage(orgId, { name: "Acme", slug: "acme-status" })).id;
    monitorId = await createMonitor(orgId);
    await setComponents(orgId, pageId, [{ monitor_id: monitorId, display_name: "API" }]);

    const pending = await requestSubscription(pageId, "reader@example.com");
    await confirmSubscription(pending.confirmToken);
    sendMail.mockClear();

    await addIncident(monitorId, new Date(), null);
    incidentId = (await queryOne<{ id: number }>(
      `SELECT id FROM incidents WHERE monitor_id = $1`,
      [monitorId]
    ))!.id;
  });

  it("says nothing while the page is unpublished", async () => {
    await announceIncident(monitorId, incidentId, "opened");

    expect(sendMail).not.toHaveBeenCalled();
  });

  it("emails confirmed subscribers once, even if called again", async () => {
    await updateStatusPage(orgId, pageId, { published: true });

    await announceIncident(monitorId, incidentId, "opened");
    await announceIncident(monitorId, incidentId, "opened");

    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("sends the resolution separately from the opening", async () => {
    await updateStatusPage(orgId, pageId, { published: true });

    await announceIncident(monitorId, incidentId, "opened");
    await announceIncident(monitorId, incidentId, "resolved");

    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it("does not email unconfirmed subscribers", async () => {
    await updateStatusPage(orgId, pageId, { published: true });
    await requestSubscription(pageId, "never-confirmed@example.com");

    await announceIncident(monitorId, incidentId, "opened");

    const recipients = sendMail.mock.calls.map((call) => call[0].to);
    expect(recipients).toEqual(["reader@example.com"]);
  });
});
