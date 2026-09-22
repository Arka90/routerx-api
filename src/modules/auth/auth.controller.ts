import { Request, Response } from "express";
import { z } from "zod";
import { requestOtp, verifyOtp } from "./auth.service";
import { config } from "../../core/config";

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

export async function requestLink(req: Request, res: Response) {
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

export function verify(req: Request, res: Response) {
  const parsed = verifySchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "Email and a valid login code are required" });
  }

  const session = verifyOtp(parsed.data.email, parsed.data.otp);

  // Deliberately one message for every failure: wrong code, expired code, too
  // many attempts, and unknown address must be indistinguishable.
  if (!session) {
    return res.status(401).json({ error: "That code is invalid or has expired" });
  }

  res.json({
    message: "Logged in!",
    sessionToken: session.token,
  });
}
