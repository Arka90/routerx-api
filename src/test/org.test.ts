import { describe, it, expect, beforeEach, vi } from "vitest";

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn().mockResolvedValue({}) }));

vi.mock("../core/mail/mailer", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendMail,
}));

import {
  acceptInvite,
  countOwners,
  createInvite,
  createOrganization,
  ensurePersonalOrganization,
  InviteError,
  listInvites,
  listMembers,
  listUserOrganizations,
  peekInvite,
  revokeInvite,
} from "../modules/org/org.service";
import { execute, query, queryOne, resetDatabase } from "./helpers/db";

async function makeUser(email: string): Promise<number> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO users (email) VALUES ($1) RETURNING id`,
    [email]
  );
  return row!.id;
}

describe("organizations", () => {
  beforeEach(async () => {
    await resetDatabase();
    sendMail.mockClear();
  });

  it("makes the creator an owner", async () => {
    const userId = await makeUser("owner@example.com");
    const org = await createOrganization(userId, "Acme");

    const members = await listMembers(org.id);

    expect(members).toHaveLength(1);
    expect(members[0].role).toBe("owner");
    expect(await countOwners(org.id)).toBe(1);
  });

  it("seeds a default notification channel so alerts are not silently dropped", async () => {
    const userId = await makeUser("owner@example.com");
    const org = await createOrganization(userId, "Acme");

    const channels = await query<{ type: string }>(
      `SELECT type FROM notification_channels WHERE org_id = $1`,
      [org.id]
    );

    expect(channels).toHaveLength(1);
    expect(channels[0].type).toBe("email");
  });

  it("gives colliding names distinct slugs", async () => {
    const a = await makeUser("a@example.com");
    const b = await makeUser("b@example.com");

    const first = await createOrganization(a, "Acme");
    const second = await createOrganization(b, "Acme");

    expect(first.slug).not.toBe(second.slug);
  });

  it("creates a personal workspace only once", async () => {
    const userId = await makeUser("solo@example.com");

    const first = await ensurePersonalOrganization(userId, "solo@example.com");
    const second = await ensurePersonalOrganization(userId, "solo@example.com");

    expect(second.id).toBe(first.id);
    expect(await listUserOrganizations(userId)).toHaveLength(1);
  });
});

describe("invitations", () => {
  let ownerId: number;
  let orgId: number;

  beforeEach(async () => {
    await resetDatabase();
    sendMail.mockClear();
    ownerId = await makeUser("owner@example.com");
    orgId = (await createOrganization(ownerId, "Acme")).id;
  });

  it("stores a hash, not the token", async () => {
    const invite = await createInvite(orgId, ownerId, "new@example.com", "member");

    const rows = await query<{ token_hash: string }>(
      `SELECT token_hash FROM org_invites WHERE id = $1`,
      [invite.id]
    );

    expect(rows[0].token_hash).not.toBe(invite.token);
    expect(await peekInvite(invite.token)).toBeDefined();
  });

  it("adds the invited user with the invited role", async () => {
    const invite = await createInvite(orgId, ownerId, "new@example.com", "admin");
    const inviteeId = await makeUser("new@example.com");

    await acceptInvite(inviteeId, "new@example.com", invite.token);

    const members = await listMembers(orgId);
    const invited = members.find((m) => m.email === "new@example.com");

    expect(invited?.role).toBe("admin");
  });

  it("cannot be accepted twice", async () => {
    const invite = await createInvite(orgId, ownerId, "new@example.com", "member");
    const inviteeId = await makeUser("new@example.com");

    await acceptInvite(inviteeId, "new@example.com", invite.token);

    await expect(
      acceptInvite(inviteeId, "new@example.com", invite.token)
    ).rejects.toBeInstanceOf(InviteError);
  });

  it("refuses to be accepted by a different account", async () => {
    const invite = await createInvite(orgId, ownerId, "intended@example.com", "member");
    const otherId = await makeUser("someone-else@example.com");

    await expect(
      acceptInvite(otherId, "someone-else@example.com", invite.token)
    ).rejects.toBeInstanceOf(InviteError);

    expect(await listMembers(orgId)).toHaveLength(1);
  });

  it("stops working once revoked", async () => {
    const invite = await createInvite(orgId, ownerId, "new@example.com", "member");
    await revokeInvite(orgId, invite.id);

    const inviteeId = await makeUser("new@example.com");

    expect(await peekInvite(invite.token)).toBeUndefined();
    await expect(
      acceptInvite(inviteeId, "new@example.com", invite.token)
    ).rejects.toBeInstanceOf(InviteError);
  });

  it("stops working once expired", async () => {
    const invite = await createInvite(orgId, ownerId, "new@example.com", "member");

    await execute(
      `UPDATE org_invites SET expires_at = now() - interval '1 hour' WHERE id = $1`,
      [invite.id]
    );

    expect(await peekInvite(invite.token)).toBeUndefined();
  });

  it("replaces an outstanding invite rather than stacking a second one", async () => {
    const first = await createInvite(orgId, ownerId, "new@example.com", "member");
    const second = await createInvite(orgId, ownerId, "new@example.com", "admin");

    expect(await listInvites(orgId)).toHaveLength(1);
    expect(await peekInvite(first.token)).toBeUndefined();
    expect(await peekInvite(second.token)).toBeDefined();
  });
});
