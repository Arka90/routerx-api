import { Redis } from "ioredis";

export const connectionOptions = {
  host: process.env.REDIS_HOST || 'redis',
  port: 6379,
  maxRetriesPerRequest: null,
};

export const connection = new Redis(connectionOptions);