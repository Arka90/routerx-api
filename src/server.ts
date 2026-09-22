import app from "./app";
import { config } from "./core/config";
import {
  scheduleRetention,
  scheduleWeeklyReport,
} from "./core/queue/schedulers/report.scheduler";

const server = app.listen(config.port, "0.0.0.0", async () => {
  console.log(`RouteRx API running on port ${config.port}`);

  // Scheduling talks to Redis; a failure here must not take the API down with
  // it, but it does need to be loud rather than an unhandled rejection.
  try {
    await scheduleWeeklyReport();
    await scheduleRetention();
  } catch (error) {
    console.error("⚠️  Failed to register scheduled jobs:", error);
  }
});

/**
 * Stop accepting connections and let in-flight requests finish before the
 * container is killed. Without this, every deploy severed live requests.
 */
function shutdown(signal: string) {
  console.log(`${signal} received — shutting down`);

  server.close(() => process.exit(0));

  // Don't hang forever on a held-open keep-alive socket.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
