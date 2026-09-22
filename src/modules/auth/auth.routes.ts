import { Router } from "express";
import { requestLink, verify } from "./auth.controller";
import { rateLimit } from "../../core/http/rate-limit";

const router = Router();

const FIFTEEN_MINUTES = 15 * 60 * 1000;

function emailKey(req: { body?: { email?: unknown } }): string | undefined {
  const email = req.body?.email;
  return typeof email === "string" ? email.trim().toLowerCase() : undefined;
}

/**
 * Two keys per route, deliberately.
 *
 * Per-IP alone is defeated by a botnet; per-email alone is defeated by
 * walking a list of addresses from one host. Together they bound both the
 * mail we can be made to send and the guesses anyone gets at a given account.
 */
router.post(
  "/request-otp",
  rateLimit("otp-request-ip", {
    windowMs: FIFTEEN_MINUTES,
    max: 10,
    message: "Too many login codes requested. Try again in a few minutes.",
  }),
  rateLimit("otp-request-email", {
    windowMs: FIFTEEN_MINUTES,
    max: 3,
    key: emailKey,
    message: "Too many login codes requested for this address. Try again in a few minutes.",
  }),
  requestLink
);

router.post(
  "/verify-otp",
  rateLimit("otp-verify-ip", {
    windowMs: FIFTEEN_MINUTES,
    max: 20,
    message: "Too many attempts. Try again in a few minutes.",
  }),
  rateLimit("otp-verify-email", {
    windowMs: FIFTEEN_MINUTES,
    max: 10,
    key: emailKey,
    message: "Too many attempts for this address. Try again in a few minutes.",
  }),
  verify
);

export default router;
