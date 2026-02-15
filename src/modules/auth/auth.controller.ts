import { Request, Response } from "express";
import { requestMagicLink, verifyToken } from "./auth.service";

export async function requestLink(req: Request, res: Response) {
  const { email } = req.body;

  if (!email) return res.status(400).json({ error: "email required" });

  await requestMagicLink(email);
  res.json({ message: "Magic link sent! Check your email." });
}

export function verify(req: Request, res: Response) {
  const token = req.query.token as string;

  if (!token) return res.status(400).json({ error: "token missing" });

  const session = verifyToken(token);

  if (!session) return res.status(401).json({ error: "invalid or expired token" });

  res.json({
    message: "Logged in!",
    sessionToken: session.token,
  });
}
