import { z } from "zod";

/**
 * Header names are restricted to the RFC token characters. Node would throw
 * on a newline anyway, but rejecting it here gives a clear 400 instead of a
 * 500, and makes the intent explicit: no CRLF, no header injection.
 */
const headerName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/, "Invalid header name")
  .refine((name) => name.toLowerCase() !== "host", {
    message: "The Host header cannot be overridden",
  });

const headerValue = z
  .string()
  .max(2048)
  .regex(/^[^\r\n]*$/, "Header values cannot contain line breaks");

export const requestHeadersSchema = z
  .record(headerName, headerValue)
  .refine((headers) => Object.keys(headers).length <= 20, {
    message: "At most 20 request headers",
  });

const assertionType = z.enum(["none", "contains", "not_contains", "json_path"]);

const baseMonitorFields = {
  name: z.string().trim().max(120).nullish(),
  url: z.string().trim().url().max(2048),
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  request_headers: requestHeadersSchema.default({}),
  request_body: z.string().max(64 * 1024).nullish(),
  expected_status_codes: z.array(z.number().int().min(100).max(599)).max(20).default([]),
  assertion_type: assertionType.default("none"),
  assertion_value: z.string().trim().max(1000).nullish(),
  timeout_ms: z.number().int().min(1000).max(60_000).default(10_000),
  follow_redirects: z.boolean().default(true),
  interval_seconds: z.number().int().min(30).max(3600).default(60),
  // Empty means every enabled region.
  regions: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  paused: z.boolean().default(false),
};

/** An assertion type other than "none" is meaningless without a value. */
function assertionIsCoherent(data: {
  assertion_type?: string;
  assertion_value?: string | null;
}) {
  if (!data.assertion_type || data.assertion_type === "none") return true;
  return Boolean(data.assertion_value && data.assertion_value.trim());
}

export const createMonitorSchema = z
  .object(baseMonitorFields)
  .refine(assertionIsCoherent, {
    message: "An assertion value is required for this assertion type",
    path: ["assertion_value"],
  });

export const updateMonitorSchema = z
  .object(baseMonitorFields)
  .partial()
  .refine(assertionIsCoherent, {
    message: "An assertion value is required for this assertion type",
    path: ["assertion_value"],
  });

export const alertPolicySchema = z.object({
  failure_threshold: z.number().int().min(1).max(10).optional(),
  recovery_threshold: z.number().int().min(1).max(10).optional(),
  alert_on_slow: z.boolean().optional(),
  slow_threshold_ms: z.number().int().min(100).max(60_000).optional(),
  renotify_minutes: z.number().int().min(5).max(1440).nullable().optional(),
  confirmations: z.number().int().min(1).max(10).optional(),
  muted_until: z.string().datetime({ offset: true }).nullable().optional(),
  channel_ids: z.array(z.number().int().positive()).max(20).optional(),
});

export const maintenanceSchema = z
  .object({
    starts_at: z.string().datetime({ offset: true }),
    ends_at: z.string().datetime({ offset: true }),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((data) => new Date(data.ends_at) > new Date(data.starts_at), {
    message: "ends_at must be after starts_at",
    path: ["ends_at"],
  });
