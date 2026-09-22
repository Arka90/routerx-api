import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../../core/config";

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

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as { id: number; email: string };
    
    // attach user to request
    req.user = {
      id: decoded.id,
      email: decoded.email,
    };

    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
