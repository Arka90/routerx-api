import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import healthRoute from "./modules/health/health.route";
import probeRoutes from "./modules/probe/probe.route";
import authRoutes from "./modules/auth/auth.routes";
import orgRoutes from "./modules/org/org.route";
import inviteRoutes from "./modules/org/invite.route";
import channelRoutes from "./modules/channels/channel.route";
import statusPageRoutes from "./modules/status-pages/status-page.route";
import publicStatusRoutes from "./modules/status-pages/public.route";
import regionRoutes from "./modules/regions/region.route";
import billingRoutes from "./modules/billing/billing.route";
import { webhookHandler } from "./modules/billing/billing.controller";
import monitorRoutes from "./modules/monitor/monitor.route";
import incidentRoutes from "./modules/incident/incident.route";
import { requireAuth } from "./modules/auth/auth.middleware";
import { rateLimit } from "./core/http/rate-limit";
import { securityHeaders } from "./core/http/security-headers";
import { config } from "./core/config";

const app = express();

// Without this, every request behind nginx/Cloudflare reports the proxy's IP
// and the per-IP rate limits share one bucket across all callers.
if (config.trustProxy) {
  const value = Number(config.trustProxy);
  app.set("trust proxy", Number.isNaN(value) ? config.trustProxy : value);
}

app.use(securityHeaders);

if (config.corsOrigins.length > 0) {
  app.use(cors({ origin: config.corsOrigins, exposedHeaders: ["Retry-After"] }));
} else {
  console.warn(
    "⚠️  CORS_ORIGINS is not set — every origin is allowed. Set it to your " +
      "frontend's URL (comma-separated for more than one) before going live."
  );
  app.use(cors({ exposedHeaders: ["Retry-After"] }));
}

/**
 * Mounted before the JSON parser on purpose. A Stripe signature covers the
 * exact bytes that were sent, so the handler needs the raw body — parsing and
 * re-serialising would reorder keys and fail every verification.
 */
app.post(
  "/billing/webhook",
  express.raw({ type: "application/json", limit: "1mb" }),
  webhookHandler
);

app.use(express.json({ limit: "256kb" }));

// Coarse backstop under the per-route limits, so no single client can
// saturate the process even on endpoints without their own limiter.
app.use(rateLimit("global", { windowMs: 60 * 1000, max: 600 }));

app.use("/health", healthRoute);
app.use("/auth", authRoutes);

// The public status page. Unauthenticated by design — it is what customers
// read during an outage, which is exactly when it gets the most traffic.
app.use("/status", publicStatusRoutes);
app.use("/invites", inviteRoutes);
app.use("/orgs", orgRoutes);
app.use("/channels", channelRoutes);
app.use("/status-pages", statusPageRoutes);
app.use("/regions", regionRoutes);
app.use("/billing", billingRoutes);
app.use("/monitor", monitorRoutes);
app.use("/incidents", incidentRoutes);

// /probe performs arbitrary outbound DNS/TCP/TLS/HTTP from this host, so it
// stays behind authentication.
app.use("/probe", requireAuth, probeRoutes);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

/**
 * Express 5 forwards a rejected promise from an async handler here, which is
 * what lets the controllers above throw instead of wrapping every call in
 * try/catch. The message is deliberately generic — stack traces and driver
 * errors are for the logs.
 */
app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", error);

  if (res.headersSent) return;

  res.status(500).json({ error: "Something went wrong on our end" });
});

export default app;
