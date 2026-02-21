import { Request, Response } from "express";
import { requestOtp, verifyOtp } from "./auth.service";

export async function requestLink(req: Request, res: Response) {
  const { email } = req.body;

  if (!email) return res.status(400).json({ error: "email required" });

  const { ok } = await requestOtp(email);
  res.json({ message: "OTP sent! Check your email." });
}

export function verify(req: Request, res: Response) {
  const { email, otp } = req.body;

  if (!email || !otp) return res.status(400).json({ error: "email and otp required" });

  const session = verifyOtp(email, otp);

  if (!session) return res.status(401).json({ error: "invalid or expired OTP" });

  res.json({
    message: "Logged in!",
    sessionToken: session.token,
  });
}
