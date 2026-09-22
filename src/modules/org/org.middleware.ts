import { Response, NextFunction } from "express";
import { AuthRequest } from "../auth/auth.middleware";
import { getMembership, listUserOrganizations, type OrgRole } from "./org.service";

const RANK: Record<OrgRole, number> = { member: 1, admin: 2, owner: 3 };

/**
 * Resolve which organization this request is acting on.
 *
 * The client names it with an X-Org-Id header. When it doesn't, we fall back
 * to the user's oldest membership — almost everyone has exactly one, and
 * making the header mandatory would break every existing client for no gain.
 * Membership is verified either way, so the header is a selector, not a
 * credential.
 */
export async function requireOrg(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  const header = req.headers["x-org-id"];
  const requested = Array.isArray(header) ? header[0] : header;

  try {
    if (requested) {
      const orgId = Number(requested);

      if (!Number.isInteger(orgId) || orgId <= 0) {
        return res.status(400).json({ error: "Invalid X-Org-Id header" });
      }

      const membership = await getMembership(req.user.id, orgId);

      // 404, not 403: confirming an organization exists is itself a leak.
      if (!membership) {
        return res.status(404).json({ error: "Organization not found" });
      }

      req.orgId = membership.id;
      req.orgName = membership.name;
      req.orgRole = membership.role;
      return next();
    }

    const organizations = await listUserOrganizations(req.user.id);

    if (organizations.length === 0) {
      return res.status(403).json({
        error: "You are not a member of any organization",
      });
    }

    req.orgId = organizations[0].id;
    req.orgName = organizations[0].name;
    req.orgRole = organizations[0].role;
    next();
  } catch (error) {
    console.error("Could not resolve organization:", error);
    res.status(503).json({ error: "Could not resolve your organization right now" });
  }
}

/**
 * Gate on role. Members are read-only by design: they see everything and can
 * acknowledge an incident, but changing what gets monitored or who is in the
 * organization takes admin.
 */
export function requireRole(minimum: OrgRole) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.orgRole) {
      return res.status(403).json({ error: "No organization context" });
    }

    if (RANK[req.orgRole] < RANK[minimum]) {
      return res.status(403).json({
        error: `This action requires the ${minimum} role`,
      });
    }

    next();
  };
}
