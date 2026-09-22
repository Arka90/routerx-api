import app from "./app";
import { config } from "./core/config";
import { runMigrations } from "./core/db/migrate";
import { closePool } from "./core/db/client";
import {
  scheduleRetention,
  scheduleWeeklyReport,
} from "./core/queue/schedulers/report.scheduler";
import { syncMonitorSchedules } from "./core/queue/schedulers/sync";

async function start() {
  // Migrations run before the listener opens, so the process never serves a
  // request against a schema it has not finished applying.
  await runMigrations();

  const server = app.listen(config.port, "0.0.0.0", async () => {
    console.log(`RouteRx API running on port ${config.port}`);

    // Redis work must not take the API down with it, but it does need to be
    // loud rather than an unhandled rejection.
    try {
      await scheduleWeeklyReport();
      await scheduleRetention();
      await syncMonitorSchedules();
    } catch (error) {
      console.error("⚠️  Failed to register scheduled jobs:", error);
    }
  });

  function shutdown(signal: string) {
    console.log(`${signal} received — shutting down`);

    server.close(async () => {
      await closePool().catch(() => undefined);
      process.exit(0);
    });

    // Don't hang forever on a held-open keep-alive socket.
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch((error) => {
  console.error("Failed to start:", error);
  process.exit(1);
});
