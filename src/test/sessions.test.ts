import { describe, it, expect, beforeEach } from "vitest";
import {
  createSession,
  listSessions,
  resolveSession,
  revokeAllSessions,
  revokeSession,
} from "../modules/auth/session.service";
import { execute, queryOne, resetDatabase } from "./helpers/db";

async function makeUser(): Promise<number> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO users (email) VALUES ('sessions@example.com') RETURNING id`
  );
  return row!.id;
}

describe("sessions", () => {
  let userId: number;

  beforeEach(async () => {
    await resetDatabase();
    userId = await makeUser();
  });

  it("resolves a freshly issued token", async () => {
    const { token } = await createSession(userId, { userAgent: "vitest", ip: "127.0.0.1" });

    const session = await resolveSession(token);

    expect(session?.user.id).toBe(userId);
  });

  it("stops resolving the moment the session is revoked", async () => {
    const { token } = await createSession(userId);
    const session = await resolveSession(token);

    // This is the whole point of server-side sessions: the previous design
    // could not invalidate a token before its 7-day expiry.
    await revokeSession(userId, session!.sessionId);

    expect(await resolveSession(token)).toBeNull();
  });

  it("refuses an expired session", async () => {
    const { token } = await createSession(userId);

    await execute(`UPDATE sessions SET expires_at = now() - interval '1 day'`);

    expect(await resolveSession(token)).toBeNull();
  });

  it("refuses a token that was never issued", async () => {
    expect(await resolveSession("not-a-real-token")).toBeNull();
  });

  it("will not let one user revoke another's session", async () => {
    const other = await queryOne<{ id: number }>(
      `INSERT INTO users (email) VALUES ('other@example.com') RETURNING id`
    );

    const { token } = await createSession(userId);
    const session = await resolveSession(token);

    expect(await revokeSession(other!.id, session!.sessionId)).toBe(false);
    expect(await resolveSession(token)).not.toBeNull();
  });

  it("signs out everywhere else while keeping the current session", async () => {
    const current = await createSession(userId);
    const currentSession = await resolveSession(current.token);
    const other = await createSession(userId);

    const revoked = await revokeAllSessions(userId, currentSession!.sessionId);

    expect(revoked).toBe(1);
    expect(await resolveSession(current.token)).not.toBeNull();
    expect(await resolveSession(other.token)).toBeNull();
  });

  it("lists only live sessions", async () => {
    await createSession(userId);
    const second = await createSession(userId);
    const session = await resolveSession(second.token);

    await revokeSession(userId, session!.sessionId);

    expect(await listSessions(userId)).toHaveLength(1);
  });
});
