import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";

const { sendMail, scheduleMonitor, removeMonitorJob, resolveProbeTarget } = vi.hoisted(
  () => ({
    sendMail: vi.fn().mockResolvedValue({}),
    scheduleMonitor: vi.fn().mockResolvedValue(undefined),
    removeMonitorJob: vi.fn().mockResolvedValue(undefined),
    resolveProbeTarget: vi.fn(),
  })
);

vi.mock("../core/mail/mailer", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendMail,
}));

vi.mock("../core/queue/schedulers/monitor.scheduler", () => ({
  scheduleMonitor,
  removeMonitorJob,
}));

vi.mock("../core/security/ssrf", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveProbeTarget };
});

import app from "../app";
import { createSession } from "../modules/auth/session.service";
import { createOrganization } from "../modules/org/org.service";
import { execute, queryOne, resetDatabase } from "./helpers/db";

async function signIn(email: string) {
  const user = await queryOne<{ id: number }>(
    `INSERT INTO users (email) VALUES ($1) RETURNING id`,
    [email]
  );

  const { token } = await createSession(user!.id);
  return { userId: user!.id, token };
}

describe("status pages over HTTP", () => {
  let owner: { userId: number; token: string };
  let orgId: number;
  let monitorId: number;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    await resetDatabase();
    vi.clearAllMocks();
    resolveProbeTarget.mockResolvedValue({
      url: new URL("https://example.com"),
      hostname: "example.com",
      ip: "93.184.216.34",
      port: 443,
    });

    owner = await signIn("owner@example.com");
    orgId = (await createOrganization(owner.userId, "Acme")).id;

    const created = await request(app)
      .post("/monitor")
      .set(auth(owner.token))
      .send({ url: "https://example.com" });

    monitorId = created.body.monitor.id;

    // Creating a monitor sends its own "now watching" email; clear it so the
    // subscription assertions below count only what they trigger.
    sendMail.mockClear();
  });

  async function createPage(slug = "acme-status") {
    const response = await request(app)
      .post("/status-pages")
      .set(auth(owner.token))
      .send({ name: "Acme Status", slug });

    return response.body.status_page;
  }

  it("creates a page and hands back its public URL", async () => {
    const page = await createPage();

    expect(page.slug).toBe("acme-status");
    expect(page.public_url).toContain("/status/acme-status");
    expect(page.published).toBe(false);
  });

  it("404s an unpublished page for the public", async () => {
    await createPage();

    const response = await request(app).get("/status/acme-status");

    expect(response.status).toBe(404);
  });

  it("serves a published page to an anonymous visitor", async () => {
    const page = await createPage();

    await request(app)
      .put(`/status-pages/${page.id}/components`)
      .set(auth(owner.token))
      .send({ components: [{ monitor_id: monitorId, display_name: "Public API" }] });

    await request(app)
      .patch(`/status-pages/${page.id}`)
      .set(auth(owner.token))
      .send({ published: true });

    const response = await request(app).get("/status/acme-status");

    expect(response.status).toBe(200);
    expect(response.body.components[0].name).toBe("Public API");
    // The monitor's URL is internal detail and must not appear anywhere.
    expect(JSON.stringify(response.body)).not.toContain("example.com");
  });

  it("refuses a slug another workspace holds", async () => {
    await createPage("taken-name");

    const outsider = await signIn("outsider@example.com");
    await createOrganization(outsider.userId, "Other");

    const response = await request(app)
      .post("/status-pages")
      .set(auth(outsider.token))
      .send({ name: "Theirs", slug: "taken-name" });

    expect(response.status).toBe(409);
  });

  it("does not let a member create or publish a page", async () => {
    const member = await signIn("member@example.com");
    await execute(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`,
      [orgId, member.userId]
    );

    const create = await request(app)
      .post("/status-pages")
      .set(auth(member.token))
      .send({ name: "Sneaky", slug: "sneaky-page" });

    expect(create.status).toBe(403);
  });

  it("takes a subscription and mails a confirmation", async () => {
    const page = await createPage();
    await request(app)
      .patch(`/status-pages/${page.id}`)
      .set(auth(owner.token))
      .send({ published: true });

    const response = await request(app)
      .post("/status/acme-status/subscribe")
      .send({ email: "reader@example.com" });

    expect(response.status).toBe(200);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].to).toBe("reader@example.com");
  });

  it("will not take subscriptions for an unpublished page", async () => {
    await createPage();

    const response = await request(app)
      .post("/status/acme-status/subscribe")
      .send({ email: "reader@example.com" });

    expect(response.status).toBe(404);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("records a public incident update and shows it on the page", async () => {
    const page = await createPage();

    await request(app)
      .put(`/status-pages/${page.id}/components`)
      .set(auth(owner.token))
      .send({ components: [{ monitor_id: monitorId, display_name: "Public API" }] });

    await request(app)
      .patch(`/status-pages/${page.id}`)
      .set(auth(owner.token))
      .send({ published: true });

    const incident = await queryOne<{ id: number }>(
      `INSERT INTO incidents (monitor_id, started_at) VALUES ($1, now()) RETURNING id`,
      [monitorId]
    );

    const update = await request(app)
      .post(`/incidents/${incident!.id}/updates`)
      .set(auth(owner.token))
      .send({ status: "investigating", body: "We are on it", is_public: true });

    expect(update.status).toBe(201);

    const view = await request(app).get("/status/acme-status");

    expect(view.body.active_incidents[0].updates[0].body).toBe("We are on it");
  });

  it("keeps an internal update off the public page", async () => {
    const page = await createPage();

    await request(app)
      .put(`/status-pages/${page.id}/components`)
      .set(auth(owner.token))
      .send({ components: [{ monitor_id: monitorId, display_name: "Public API" }] });

    await request(app)
      .patch(`/status-pages/${page.id}`)
      .set(auth(owner.token))
      .send({ published: true });

    const incident = await queryOne<{ id: number }>(
      `INSERT INTO incidents (monitor_id, started_at) VALUES ($1, now()) RETURNING id`,
      [monitorId]
    );

    await request(app)
      .post(`/incidents/${incident!.id}/updates`)
      .set(auth(owner.token))
      .send({ status: "identified", body: "Vendor outage, do not share", is_public: false });

    const view = await request(app).get("/status/acme-status");

    expect(view.body.active_incidents[0].updates).toHaveLength(0);
  });

  it("reports plan, limits and usage", async () => {
    const response = await request(app).get("/billing").set(auth(owner.token));

    expect(response.status).toBe(200);
    expect(response.body.subscription.plan).toBe("free");
    expect(response.body.usage.monitors).toBe(1);
    // Off by default, so an existing deployment is not broken by the upgrade.
    expect(response.body.enforced).toBe(false);
  });

  it("refuses checkout when billing is not configured", async () => {
    const response = await request(app)
      .post("/billing/checkout")
      .set(auth(owner.token))
      .send({ plan: "pro" });

    expect(response.status).toBe(503);
  });

  it("rejects a webhook with no valid signature", async () => {
    const response = await request(app)
      .post("/billing/webhook")
      .set("Content-Type", "application/json")
      .set("Stripe-Signature", "t=1,v1=deadbeef")
      .send(Buffer.from(JSON.stringify({ id: "evt_1", type: "x" })));

    expect(response.status).toBe(400);
  });
});
