import { Request, Response } from "express";
import { db } from "../../core/db/client";
import { connection } from "../../core/queue/redis";

/**
 * Liveness: the process is up and serving. Deliberately shallow so a
 * dependency blip never gets the container restarted out from under us.
 */
export function healthController(_req: Request, res: Response) {
  res.json({
    status: "ok",
    service: "routerx-api",
  });
}

/**
 * Readiness: the process can actually do its job. This is what a load
 * balancer or `docker compose` healthcheck should poll — the shallow endpoint
 * above returned 200 even with the database unreadable and Redis gone, so a
 * fully broken deploy looked healthy.
 */
export async function readinessController(_req: Request, res: Response) {
  const checks: Record<string, "ok" | "error"> = {
    database: "error",
    redis: "error",
  };

  try {
    db.prepare("SELECT 1").get();
    checks.database = "ok";
  } catch (error) {
    console.error("Readiness: database check failed:", error);
  }

  try {
    // Without a bound, a half-open connection leaves the probe hanging until
    // the poller times out, which reads as a much worse outage than it is.
    await Promise.race([
      connection.ping(),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("redis ping timed out")), 2000)
      ),
    ]);
    checks.redis = "ok";
  } catch (error) {
    console.error("Readiness: redis check failed:", error);
  }

  const ready = Object.values(checks).every((state) => state === "ok");

  res.status(ready ? 200 : 503).json({
    status: ready ? "ok" : "degraded",
    service: "routerx-api",
    checks,
  });
}
