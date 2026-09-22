import { Router } from "express";
import { rateLimit } from "../../core/http/rate-limit";
import {
  confirmHandler,
  subscribeHandler,
  unsubscribeHandler,
  viewStatusPage,
} from "./public.controller";

const router = Router();

/**
 * Unauthenticated by design — this is the page customers read during an
 * outage, which is exactly when it gets the most traffic. Rate limits are
 * generous for reads and tight for anything that sends mail.
 */
router.get(
  "/:slug",
  rateLimit("status-page-view", { windowMs: 60_000, max: 120 }),
  viewStatusPage
);

router.post(
  "/:slug/subscribe",
  rateLimit("status-subscribe-ip", {
    windowMs: 15 * 60_000,
    max: 5,
    message: "Too many subscription attempts. Try again in a few minutes.",
  }),
  rateLimit("status-subscribe-email", {
    windowMs: 60 * 60_000,
    max: 3,
    key: (req) => {
      const email = (req.body as { email?: unknown })?.email;
      return typeof email === "string" ? email.trim().toLowerCase() : undefined;
    },
    message: "Too many subscription attempts for this address.",
  }),
  subscribeHandler
);

router.post(
  "/subscriptions/confirm/:token",
  rateLimit("status-confirm", { windowMs: 60_000, max: 20 }),
  confirmHandler
);

router.post(
  "/subscriptions/unsubscribe/:token",
  rateLimit("status-unsubscribe", { windowMs: 60_000, max: 20 }),
  unsubscribeHandler
);

export default router;
