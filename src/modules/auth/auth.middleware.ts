import { Request, Response, NextFunction } from "express";
import { resolveSession, type SessionUser } from "./session.service";

export interface AuthRequest extends Request {
  user?: SessionUser;
  sessionId?: number;
  /** Set by requireOrg. */
  orgId?: number;
  orgName?: string;
  orgRole?: "owner" | "admin" | "member";
}

export async function requireAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = authHeader.slice("Bearer ".length).trim();

  try {
    const session = await resolveSession(token);

    // A revoked or expired session lands here too, which is the point: the
    // token alone is no longer proof of anything.
    if (!session) {
      return res.status(401).json({ error: "Session expired or revoked" });
    }

    req.user = session.user;
    req.sessionId = session.sessionId;

    next();
  } catch (error) {
    console.error("Session lookup failed:", error);
    res.status(503).json({ error: "Could not verify your session right now" });
  }
}
