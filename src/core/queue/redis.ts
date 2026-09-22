import { Redis } from "ioredis";

export const connectionOptions = {
  host: process.env.REDIS_HOST || "redis",
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
};

export const connection = new Redis(connectionOptions);

// ioredis reconnects on its own, but an "error" event with no listener is
// logged by the driver as an unhandled error and, on some Node versions,
// escalates. One line keeps a reconnect from looking like a crash.
connection.on("error", (error) => {
  console.error("Redis connection error:", error.message);
});
