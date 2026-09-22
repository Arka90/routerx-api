import express from "express";
import cors from "cors";
import healthRoute from "./modules/health/health.route";
import probeRoutes from "./modules/probe/probe.route";
import authRoutes from "./modules/auth/auth.routes";
import monitorRoutes from "./modules/monitor/monitor.route";
import incidentRoutes from "./modules/incident/incident.route";
import { runMigrations } from "./core/db/migrate";
import { requireAuth } from "./modules/auth/auth.middleware";
import { rateLimit } from "./core/http/rate-limit";
import { securityHeaders } from "./core/http/security-headers";
import { config } from "./core/config";
import "./core/db/client";

const app = express();

// Without this, every request behind nginx/Cloudflare reports the proxy's IP
// and the per-IP rate limits below share one bucket across all callers.
if (config.trustProxy) {
  const value = Number(config.trustProxy);
  app.set("trust proxy", Number.isNaN(value) ? config.trustProxy : value);
}

app.use(securityHeaders);

if (config.corsOrigins.length > 0) {
  app.use(cors({ origin: config.corsOrigins }));
} else {
  console.warn(
    "⚠️  CORS_ORIGINS is not set — every origin is allowed. Set it to your " +
      "frontend's URL (comma-separated for more than one) before going live."
  );
  app.use(cors());
}

// Cap the body size: the default is 100kb, but being explicit keeps a future
// bump from silently turning into a memory-exhaustion vector.
app.use(express.json({ limit: "64kb" }));

// Coarse backstop under the per-route limits, so no single client can
// saturate the process even on endpoints without their own limiter.
app.use(
  rateLimit("global", {
    windowMs: 60 * 1000,
    max: 300,
  })
);

runMigrations();

app.use("/health", healthRoute);
app.use("/auth", authRoutes);

// /probe performs arbitrary outbound DNS/TCP/TLS/HTTP from this host. It was
// mounted publicly, which made it a general-purpose SSRF and port-scanning
// tool for anyone who found the URL.
app.use("/probe", requireAuth, probeRoutes);

app.use("/monitor", requireAuth, monitorRoutes);
app.use("/incidents", requireAuth, incidentRoutes);

export default app;
