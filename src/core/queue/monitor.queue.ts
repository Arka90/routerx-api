import { Queue } from "bullmq";
import { connectionOptions } from "./redis";

export const monitorQueue = new Queue("monitor-check", {
  connection: connectionOptions,
});
