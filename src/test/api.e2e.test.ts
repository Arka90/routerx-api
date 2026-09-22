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

// Scheduling talks to Redis, which these tests are not about.
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

const VALID_TARGET = {
  url: new URL("https://example.com"),
  hostname: "example.com",
  ip: "93.184.216.34",
  port: 443,
};

describe("API surface", () => {
  let owner: { userId: number; token: string };
  let orgId: number;

  beforeEach(async () => {
    await resetDatabase();
    vi.clearAllMocks();
    resolveProbeTarget.mockResolvedValue(VALID_TARGET);

    owner = await signIn("owner@example.com");
    orgId = (await createOrganization(owner.userId, "Acme")).id;
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  it("rejects an unauthenticated request", async () => {
    const response = await request(app).get("/monitor");
    expect(response.status).toBe(401);
  });

  it("rejects a revoked session", async () => {
    await execute(`UPDATE sessions SET revoked_at = now()`);

    const response = await request(app).get("/monitor").set(auth(owner.token));

    expect(response.status).toBe(401);
  });

  it("creates and lists a monitor", async () => {
    const create = await request(app)
      .post("/monitor")
      .set(auth(owner.token))
      .send({ url: "https://example.com", interval_seconds: 60 });

    expect(create.status).toBe(201);
    // Third argument is the resolved region list; with one region seeded
    // by the initial migration that is ['default'].
    expect(scheduleMonitor).toHaveBeenCalledWith(create.body.monitor.id, 60, [
      "default",
    ]);

    const list = await request(app).get("/monitor").set(auth(owner.token));

    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].org_id).toBe(orgId);
  });

  it("refuses a monitor whose hostname resolves inward", async () => {
    const { BlockedTargetError } = await import("../core/security/ssrf");
    resolveProbeTarget.mockRejectedValueOnce(
      new BlockedTargetError("localhost resolves to a private or reserved address (127.0.0.1)")
    );

    const response = await request(app)
      .post("/monitor")
      .set(auth(owner.token))
      .send({ url: "http://localhost:6379" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("private or reserved");
  });

  it("rejects an assertion type with no value", async () => {
    const response = await request(app)
      .post("/monitor")
      .set(auth(owner.token))
      .send({ url: "https://example.com", assertion_type: "contains" });

    expect(response.status).toBe(400);
  });

  it("rejects a header value containing a line break", async () => {
    const response = await request(app)
      .post("/monitor")
      .set(auth(owner.token))
      .send({
        url: "https://example.com",
        request_headers: { "X-Test": "value\r\nInjected: yes" },
      });

    expect(response.status).toBe(400);
  });

  describe("workspace isolation", () => {
    it("hides another workspace's monitor", async () => {
      const create = await request(app)
        .post("/monitor")
        .set(auth(owner.token))
        .send({ url: "https://example.com" });

      const outsider = await signIn("outsider@example.com");
      await createOrganization(outsider.userId, "Other");

      const response = await request(app)
        .get(`/monitor/${create.body.monitor.id}`)
        .set(auth(outsider.token));

      expect(response.status).toBe(404);
    });

    it("refuses an X-Org-Id the caller is not a member of", async () => {
      const outsider = await signIn("outsider@example.com");
      await createOrganization(outsider.userId, "Other");

      const response = await request(app)
        .get("/monitor")
        .set(auth(outsider.token))
        .set("X-Org-Id", String(orgId));

      // 404 rather than 403: confirming the workspace exists is itself a leak.
      expect(response.status).toBe(404);
    });
  });

  describe("roles", () => {
    async function addMember(email: string, role: "admin" | "member") {
      const member = await signIn(email);

      await execute(
        `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)`,
        [orgId, member.userId, role]
      );

      return member;
    }

    it("lets a member read but not create", async () => {
      const member = await addMember("member@example.com", "member");

      expect((await request(app).get("/monitor").set(auth(member.token))).status).toBe(200);

      const create = await request(app)
        .post("/monitor")
        .set(auth(member.token))
        .send({ url: "https://example.com" });

      expect(create.status).toBe(403);
    });

    it("lets a member acknowledge an incident", async () => {
      const create = await request(app)
        .post("/monitor")
        .set(auth(owner.token))
        .send({ url: "https://example.com" });

      const incident = await queryOne<{ id: number }>(
        `INSERT INTO incidents (monitor_id, started_at) VALUES ($1, now()) RETURNING id`,
        [create.body.monitor.id]
      );

      const member = await addMember("member@example.com", "member");

      const response = await request(app)
        .post(`/incidents/${incident!.id}/ack`)
        .set(auth(member.token));

      expect(response.status).toBe(200);
    });

    it("lets an admin create a monitor", async () => {
      const admin = await addMember("admin@example.com", "admin");

      const response = await request(app)
        .post("/monitor")
        .set(auth(admin.token))
        .send({ url: "https://example.com" });

      expect(response.status).toBe(201);
    });

    it("stops an admin promoting anyone to owner", async () => {
      const admin = await addMember("admin@example.com", "admin");

      const response = await request(app)
        .patch(`/orgs/members/${admin.userId}`)
        .set(auth(admin.token))
        .send({ role: "owner" });

      expect(response.status).toBe(403);
    });

    it("stops the last owner demoting themselves", async () => {
      const response = await request(app)
        .patch(`/orgs/members/${owner.userId}`)
        .set(auth(owner.token))
        .send({ role: "member" });

      expect(response.status).toBe(400);
    });
  });

  it("returns every incident in the workspace from one endpoint", async () => {
    const create = await request(app)
      .post("/monitor")
      .set(auth(owner.token))
      .send({ url: "https://example.com" });

    await execute(
      `INSERT INTO incidents (monitor_id, started_at, resolved_at) VALUES ($1, now(), now())`,
      [create.body.monitor.id]
    );

    const response = await request(app).get("/incidents").set(auth(owner.token));

    expect(response.status).toBe(200);
    expect(response.body.incidents).toHaveLength(1);
    expect(response.body.incidents[0].monitor_url).toBe("https://example.com");
  });

  it("keeps /probe behind authentication", async () => {
    const anonymous = await request(app).get("/probe?url=http://169.254.169.254/");
    expect(anonymous.status).toBe(401);
  });

  it("answers /health without a database round trip", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
  });

  it("404s an unknown route as JSON", async () => {
    const response = await request(app).get("/nope");

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Not found");
  });
});
