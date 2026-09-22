import { Request, Response, NextFunction } from "express";

/**
 * Fixed-window rate limiter.
 *
 * State is in-process, which is correct for the current single-container
 * deployment but does NOT hold once the API runs more than one replica: each
 * replica would enforce its own allowance. Move the counters to Redis at the
 * same time as the second instance.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Keys are cheap but unbounded (one per client IP / email), so expire them.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60_000);
sweep.unref();

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** What to count against. Defaults to the client IP. */
  key?: (req: Request) => string | undefined;
  message?: string;
}

export function rateLimit(name: string, options: RateLimitOptions) {
  const {
    windowMs,
    max,
    key,
    message = "Too many requests. Please slow down and try again shortly.",
  } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    const subject = key ? key(req) : req.ip;

    // No usable key (e.g. a body-derived key on a malformed request) — let the
    // handler's own validation reject it rather than silently allowing it
    // through an unkeyed bucket.
    if (!subject) return next();

    const bucketKey = `${name}:${subject}`;
    const now = Date.now();
    const bucket = buckets.get(bucketKey);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count += 1;

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: message, retry_after_seconds: retryAfter });
    }

    next();
  };
}

/** Test helper — clears every window. */
export function resetRateLimits() {
  buckets.clear();
}
