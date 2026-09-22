import { Redis } from "ioredis";
import { config } from "../config";

export const connectionOptions = {
  host: process.env.REDIS_HOST || "redis",
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
};

/**
 * Lazy in tests: importing anything that touches this module would otherwise
 * start a reconnect loop against a Redis nobody is running, and bury the test
 * output in connection errors. The readiness check still connects on demand.
 */
export const connection = new Redis({
  ...connectionOptions,
  lazyConnect: config.isTest,
});

// ioredis reconnects on its own, but an "error" event with no listener is
// logged by the driver as an unhandled error and, on some Node versions,
// escalates. One line keeps a reconnect from looking like a crash.
connection.on("error", (error) => {
  console.error("Redis connection error:", error.message);
});
