import { Request, Response, NextFunction } from "express";
import { db } from "../../core/db/client";

export interface AuthRequest extends Request {
  user?: {
    id: number;
    email: string;
  };
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];

  // find session
  const session = db
    .prepare(`
      SELECT sessions.*, users.email
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE token = ?
    `)
    .get(token) as any;

  if (!session) {
    return res.status(401).json({ error: "Invalid session" });
  }

  // expired?
  if (new Date(session.expires_at) < new Date()) {
    return res.status(401).json({ error: "Session expired" });
  }

  // attach user to request
  req.user = {
    id: session.user_id,
    email: session.email,
  };

  next();
}
