import { Response } from "express";
import { z } from "zod";
import { AuthRequest } from "../auth/auth.middleware";
import {
  acceptInvite,
  countOwners,
  createInvite,
  createOrganization,
  InviteError,
  listInvites,
  listMembers,
  listUserOrganizations,
  peekInvite,
  removeMember,
  revokeInvite,
  updateMemberRole,
  type OrgRole,
} from "./org.service";
import { sendInviteEmail } from "../notifications/transactional";
import { assertWithinQuota, QuotaExceededError } from "../billing/quota";

const roleSchema = z.enum(["owner", "admin", "member"]);

const createOrgSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

const inviteSchema = z.object({
  email: z.string().trim().email().max(254),
  role: roleSchema.default("member"),
});

export async function listOrganizations(req: AuthRequest, res: Response) {
  res.json({ organizations: await listUserOrganizations(req.user!.id) });
}

export async function createOrganizationHandler(req: AuthRequest, res: Response) {
  const parsed = createOrgSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "A workspace name is required" });
  }

  const organization = await createOrganization(req.user!.id, parsed.data.name);

  res.status(201).json({ organization });
}

export async function listMembersHandler(req: AuthRequest, res: Response) {
  res.json({ members: await listMembers(req.orgId!) });
}

export async function updateMemberRoleHandler(req: AuthRequest, res: Response) {
  const targetUserId = Number(req.params.userId);
  const parsed = roleSchema.safeParse(req.body?.role);

  if (!Number.isInteger(targetUserId) || !parsed.success) {
    return res.status(400).json({ error: "A valid user and role are required" });
  }

  const role: OrgRole = parsed.data;

  // Only an owner can mint another owner; an admin promoting themselves would
  // otherwise be a one-request privilege escalation.
  if (role === "owner" && req.orgRole !== "owner") {
    return res.status(403).json({ error: "Only an owner can grant ownership" });
  }

  // Demoting the last owner leaves an organization nobody can administer.
  if (targetUserId === req.user!.id && req.orgRole === "owner" && role !== "owner") {
    if ((await countOwners(req.orgId!)) <= 1) {
      return res.status(400).json({
        error: "Promote another owner before giving up ownership",
      });
    }
  }

  const updated = await updateMemberRole(req.orgId!, targetUserId, role);

  if (!updated) return res.status(404).json({ error: "Member not found" });

  res.json({ message: "Role updated" });
}

export async function removeMemberHandler(req: AuthRequest, res: Response) {
  const targetUserId = Number(req.params.userId);

  if (!Number.isInteger(targetUserId)) {
    return res.status(400).json({ error: "A valid user is required" });
  }

  if (targetUserId === req.user!.id && (await countOwners(req.orgId!)) <= 1) {
    return res.status(400).json({
      error: "You are the only owner — promote someone else before leaving",
    });
  }

  const removed = await removeMember(req.orgId!, targetUserId);

  if (!removed) return res.status(404).json({ error: "Member not found" });

  res.json({ message: "Member removed" });
}

export async function listInvitesHandler(req: AuthRequest, res: Response) {
  res.json({ invites: await listInvites(req.orgId!) });
}

export async function createInviteHandler(req: AuthRequest, res: Response) {
  const parsed = inviteSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "A valid email address is required" });
  }

  if (parsed.data.role === "owner" && req.orgRole !== "owner") {
    return res.status(403).json({ error: "Only an owner can invite another owner" });
  }

  const members = await listMembers(req.orgId!);

  if (members.some((m) => m.email.toLowerCase() === parsed.data.email.toLowerCase())) {
    return res.status(409).json({ error: "That person is already a member" });
  }

  // Checked at invite time rather than at acceptance: telling someone their
  // invitation is invalid after they click it is a worse experience than
  // telling the admin the seat is not there.
  try {
    await assertWithinQuota(req.orgId!, "members");
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      return res.status(402).json({ error: error.message, upgrade_required: true });
    }
    throw error;
  }

  const invite = await createInvite(
    req.orgId!,
    req.user!.id,
    parsed.data.email,
    parsed.data.role
  );

  try {
    await sendInviteEmail({
      to: invite.email,
      inviterEmail: req.user!.email,
      organizationName: req.orgName ?? "your workspace",
      acceptUrl: invite.acceptUrl,
      role: invite.role,
    });
  } catch (error) {
    // The invite row is valid regardless; say so rather than leaving the
    // caller thinking nothing happened.
    console.error("Could not send invite email:", error);
    return res.status(502).json({
      error: "The invitation was created but the email could not be sent",
      invite: { id: invite.id, email: invite.email, role: invite.role },
    });
  }

  res.status(201).json({
    invite: {
      id: invite.id,
      email: invite.email,
      role: invite.role,
      expires_at: invite.expiresAt,
    },
  });
}

export async function revokeInviteHandler(req: AuthRequest, res: Response) {
  const inviteId = Number(req.params.inviteId);

  if (!Number.isInteger(inviteId)) {
    return res.status(400).json({ error: "A valid invite is required" });
  }

  const revoked = await revokeInvite(req.orgId!, inviteId);

  if (!revoked) return res.status(404).json({ error: "Invite not found" });

  res.json({ message: "Invitation revoked" });
}

/** Unauthenticated: the invite page shows who invited you before you sign in. */
export async function peekInviteHandler(req: AuthRequest, res: Response) {
  const invite = await peekInvite(String(req.params.token ?? ""));

  if (!invite) {
    return res.status(404).json({ error: "This invitation is invalid or has expired" });
  }

  res.json({
    invite: {
      organization_name: invite.org_name,
      email: invite.email,
      role: invite.role,
    },
  });
}

export async function acceptInviteHandler(req: AuthRequest, res: Response) {
  try {
    const organization = await acceptInvite(
      req.user!.id,
      req.user!.email,
      String(req.params.token ?? "")
    );

    res.json({ message: "Invitation accepted", organization });
  } catch (error) {
    if (error instanceof InviteError) {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  }
}
