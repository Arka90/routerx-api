import crypto from "crypto";
import { execute, query, queryOne, withTransaction } from "../../core/db/client";
import { config } from "../../core/config";
import { ensureDefaultChannel } from "../channels/channel.service";

export type OrgRole = "owner" | "admin" | "member";

export interface Organization {
  id: number;
  name: string;
  slug: string;
  created_at: Date;
}

export interface OrgMembership extends Organization {
  role: OrgRole;
}

export interface OrgMember {
  user_id: number;
  email: string;
  name: string | null;
  role: OrgRole;
  joined_at: Date;
}

export interface OrgInvite {
  id: number;
  email: string;
  role: OrgRole;
  expires_at: Date;
  created_at: Date;
  invited_by_email: string | null;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace"
  );
}

/** Appends a short random suffix rather than looping on collisions. */
async function uniqueSlug(base: string): Promise<string> {
  const candidate = slugify(base);

  const taken = await queryOne<{ id: number }>(
    `SELECT id FROM organizations WHERE slug = $1`,
    [candidate]
  );

  if (!taken) return candidate;

  return `${candidate}-${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * Create an organization and make `userId` its owner, atomically. An
 * organization with no owner is unusable and unrecoverable through the API.
 */
export async function createOrganization(
  userId: number,
  name: string
): Promise<Organization> {
  const slug = await uniqueSlug(name);

  const org = await withTransaction(async (client) => {
    const { rows } = await client.query<Organization>(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2)
       RETURNING id, name, slug, created_at`,
      [name.trim(), slug]
    );

    const created = rows[0];

    await client.query(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [created.id, userId]
    );

    return created;
  });

  // A workspace with no channel silently drops every alert. Outside the
  // transaction on purpose: failing to seed a default must not undo the
  // organization itself.
  try {
    await ensureDefaultChannel(org.id);
  } catch (error) {
    console.error("Could not create the default notification channel:", error);
  }

  return org;
}

export async function listUserOrganizations(userId: number): Promise<OrgMembership[]> {
  return query<OrgMembership>(
    `SELECT o.id, o.name, o.slug, o.created_at, m.role
       FROM organizations o
       JOIN org_members m ON m.org_id = o.id
      WHERE m.user_id = $1
      ORDER BY m.created_at ASC`,
    [userId]
  );
}

export async function getMembership(
  userId: number,
  orgId: number
): Promise<OrgMembership | undefined> {
  return queryOne<OrgMembership>(
    `SELECT o.id, o.name, o.slug, o.created_at, m.role
       FROM organizations o
       JOIN org_members m ON m.org_id = o.id
      WHERE m.user_id = $1 AND o.id = $2`,
    [userId, orgId]
  );
}

/**
 * Every user needs somewhere to put monitors, so the first login creates a
 * personal workspace. Returns the existing one on later logins.
 */
export async function ensurePersonalOrganization(
  userId: number,
  email: string
): Promise<Organization> {
  const existing = await listUserOrganizations(userId);
  if (existing.length > 0) return existing[0];

  const handle = email.split("@")[0] || "workspace";
  return createOrganization(userId, `${handle}'s workspace`);
}

export async function listMembers(orgId: number): Promise<OrgMember[]> {
  return query<OrgMember>(
    `SELECT u.id AS user_id, u.email, u.name, m.role, m.created_at AS joined_at
       FROM org_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1
      ORDER BY m.created_at ASC`,
    [orgId]
  );
}

export async function countOwners(orgId: number): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM org_members WHERE org_id = $1 AND role = 'owner'`,
    [orgId]
  );

  return row?.count ?? 0;
}

export async function updateMemberRole(
  orgId: number,
  userId: number,
  role: OrgRole
): Promise<boolean> {
  const changed = await execute(
    `UPDATE org_members SET role = $3 WHERE org_id = $1 AND user_id = $2`,
    [orgId, userId, role]
  );

  return changed > 0;
}

export async function removeMember(orgId: number, userId: number): Promise<boolean> {
  const changed = await execute(
    `DELETE FROM org_members WHERE org_id = $1 AND user_id = $2`,
    [orgId, userId]
  );

  return changed > 0;
}

// ---------------------------------------------------------------
// Invites
// ---------------------------------------------------------------

function hashInviteToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export interface CreatedInvite {
  id: number;
  email: string;
  role: OrgRole;
  expiresAt: Date;
  /** Only ever returned here — the database stores a hash. */
  token: string;
  acceptUrl: string;
}

export async function createInvite(
  orgId: number,
  invitedBy: number,
  email: string,
  role: OrgRole
): Promise<CreatedInvite> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + config.invites.ttlHours * 60 * 60 * 1000);

  // Re-inviting the same address replaces the outstanding invite, so an
  // older link stops working rather than piling up alongside the new one.
  await execute(
    `DELETE FROM org_invites
      WHERE org_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [orgId, email]
  );

  const row = await queryOne<{ id: number }>(
    `INSERT INTO org_invites (org_id, email, role, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [orgId, email, role, hashInviteToken(token), invitedBy, expiresAt]
  );

  return {
    id: row!.id,
    email,
    role,
    expiresAt,
    token,
    acceptUrl: `${config.appUrl}/invites/${token}`,
  };
}

export async function listInvites(orgId: number): Promise<OrgInvite[]> {
  return query<OrgInvite>(
    `SELECT i.id, i.email::text AS email, i.role, i.expires_at, i.created_at,
            u.email::text AS invited_by_email
       FROM org_invites i
       LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.org_id = $1
        AND i.accepted_at IS NULL
        AND i.revoked_at IS NULL
        AND i.expires_at > now()
      ORDER BY i.created_at DESC`,
    [orgId]
  );
}

export async function revokeInvite(orgId: number, inviteId: number): Promise<boolean> {
  const changed = await execute(
    `UPDATE org_invites SET revoked_at = now()
      WHERE id = $1 AND org_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [inviteId, orgId]
  );

  return changed > 0;
}

export interface InvitePreview {
  org_id: number;
  org_name: string;
  email: string;
  role: OrgRole;
}

export async function peekInvite(token: string): Promise<InvitePreview | undefined> {
  return queryOne<InvitePreview>(
    `SELECT i.org_id, o.name AS org_name, i.email::text AS email, i.role
       FROM org_invites i
       JOIN organizations o ON o.id = i.org_id
      WHERE i.token_hash = $1
        AND i.accepted_at IS NULL
        AND i.revoked_at IS NULL
        AND i.expires_at > now()`,
    [hashInviteToken(token)]
  );
}

export class InviteError extends Error {}

/**
 * Accept an invite for `userId`.
 *
 * The invite is locked and re-checked inside the transaction: two clicks on
 * the same link arriving together would otherwise both pass the "still
 * pending" test and the second would fail on the membership unique
 * constraint with a 500.
 */
export async function acceptInvite(
  userId: number,
  userEmail: string,
  token: string
): Promise<Organization> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{
      id: number;
      org_id: number;
      email: string;
      role: OrgRole;
    }>(
      `SELECT id, org_id, email::text AS email, role
         FROM org_invites
        WHERE token_hash = $1
          AND accepted_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > now()
        FOR UPDATE`,
      [hashInviteToken(token)]
    );

    const invite = rows[0];

    if (!invite) {
      throw new InviteError("This invitation is invalid, expired, or already used");
    }

    // The invite names an address; accepting it while signed in as someone
    // else would silently add the wrong account to the organization.
    if (invite.email.toLowerCase() !== userEmail.toLowerCase()) {
      throw new InviteError(
        `This invitation was sent to ${invite.email}. Sign in as that address to accept it.`
      );
    }

    await client.query(
      `INSERT INTO org_members (org_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [invite.org_id, userId, invite.role]
    );

    await client.query(`UPDATE org_invites SET accepted_at = now() WHERE id = $1`, [
      invite.id,
    ]);

    const org = await client.query<Organization>(
      `SELECT id, name, slug, created_at FROM organizations WHERE id = $1`,
      [invite.org_id]
    );

    return org.rows[0];
  });
}
