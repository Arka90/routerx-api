import { Request, Response, NextFunction } from "express";
import { config } from "../config";

/**
 * Minimal hardening headers for a JSON API. Express advertises itself via
 * `X-Powered-By` by default, which is free reconnaissance for an attacker.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.removeHeader("X-Powered-By");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");

  if (config.isProduction) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  next();
}
