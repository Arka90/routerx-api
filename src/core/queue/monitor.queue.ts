import { Queue } from "bullmq";
import { connectionOptions } from "./redis";

/**
 * One queue per region. BullMQ workers cannot filter by job payload, so the
 * only way a worker in eu-west consumes exclusively eu-west checks is for the
 * region to be part of the queue name.
 */
export function monitorQueueName(region: string): string {
  return `monitor-check:${region}`;
}

const queues = new Map<string, Queue>();

export function monitorQueue(region: string): Queue {
  const name = monitorQueueName(region);
  const existing = queues.get(name);

  if (existing) return existing;

  const queue = new Queue(name, { connection: connectionOptions });
  queues.set(name, queue);

  return queue;
}

export async function closeMonitorQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues.clear();
}
