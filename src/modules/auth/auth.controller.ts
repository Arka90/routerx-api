import { Response } from "express";
import { z } from "zod";
import { requestOtp, verifyOtp } from "./auth.service";
import { config } from "../../core/config";
import { AuthRequest } from "./auth.middleware";
import { listSessions, revokeAllSessions, revokeSession } from "./session.service";
import { listUserOrganizations } from "../org/org.service";

const requestSchema = z.object({
  email: z.string().trim().email().max(254),
});

const verifySchema = z.object({
  email: z.string().trim().email().max(254),
  otp: z
    .string()
    .trim()
    .regex(new RegExp(`^\\d{${config.otp.length}}$`), {
      message: `Code must be ${config.otp.length} digits`,
    }),
});

export async function requestLink(req: AuthRequest, res: Response) {
  const parsed = requestSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "A valid email address is required" });
  }

  try {
    await requestOtp(parsed.data.email);
  } catch (error) {
    // A delivery failure is ours, not the caller's — say so rather than
    // claiming a code is on its way.
    console.error("Failed to issue login code:", error);
    return res
      .status(502)
      .json({ error: "Could not send the login code right now. Please try again." });
  }

  res.json({ message: "If that address can receive mail, a login code is on its way." });
}

export async function verify(req: AuthRequest, res: Response) {
  const parsed = verifySchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "Email and a valid login code are required" });
  }

  const result = await verifyOtp(parsed.data.email, parsed.data.otp, {
    userAgent: req.headers["user-agent"] ?? null,
    ip: req.ip ?? null,
  });

  // Deliberately one message for every failure: wrong code, expired code, too
  // many attempts, and unknown address must be indistinguishable.
  if (!result) {
    return res.status(401).json({ error: "That code is invalid or has expired" });
  }

  res.json({
    message: "Logged in!",
    sessionToken: result.token,
    user: result.user,
    organizations: result.organizations,
  });
}

/** Who am I, which workspaces am I in — the frontend's bootstrap call. */
export async function me(req: AuthRequest, res: Response) {
  res.json({
    user: req.user,
    organizations: await listUserOrganizations(req.user!.id),
  });
}

export async function logout(req: AuthRequest, res: Response) {
  await revokeSession(req.user!.id, req.sessionId!);
  res.json({ message: "Signed out" });
}

export async function listSessionsHandler(req: AuthRequest, res: Response) {
  const sessions = await listSessions(req.user!.id);

  res.json({
    sessions: sessions.map((session) => ({
      ...session,
      current: session.id === req.sessionId,
    })),
  });
}

export async function revokeSessionHandler(req: AuthRequest, res: Response) {
  const sessionId = Number(req.params.sessionId);

  if (!Number.isInteger(sessionId)) {
    return res.status(400).json({ error: "Invalid session" });
  }

  const revoked = await revokeSession(req.user!.id, sessionId);

  if (!revoked) return res.status(404).json({ error: "Session not found" });

  res.json({ message: "Session revoked" });
}

/** Sign out everywhere else, keeping the session making the request. */
export async function revokeOtherSessionsHandler(req: AuthRequest, res: Response) {
  const count = await revokeAllSessions(req.user!.id, req.sessionId);
  res.json({ message: `Signed out of ${count} other session(s)` });
}
