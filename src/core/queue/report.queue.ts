import { Queue } from "bullmq";
import { connectionOptions } from "./redis";

export const reportQueue = new Queue("weekly-report", {
  connection: connectionOptions,
});
