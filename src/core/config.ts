import "dotenv/config";

/**
 * Environment is read once, here, and validated at boot.
 *
 * The previous code fell back to a literal "fallback_secret_dont_use_in_prod"
 * whenever JWT_SECRET was unset, which meant a misconfigured deploy came up
 * happily and signed forgeable tokens. A missing secret must stop the process.
 */

const isTest = process.env.NODE_ENV === "test";

// The suite never issues a token anyone can use, so a fixed throwaway value
// keeps `npm test` runnable without a .env file.
const TEST_SECRET = "test-secret-not-used-outside-vitest";

function requireSecret(): string {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error(
      "JWT_SECRET is not set. Refusing to start: tokens signed with a " +
        "default secret can be forged by anyone who has read this source."
    );
  }

  if (secret.length < 32) {
    console.warn(
      `⚠️  JWT_SECRET is only ${secret.length} characters. Use at least 32 ` +
        `(\`openssl rand -hex 32\`) — short secrets are brute-forceable offline.`
    );
  }

  return secret;
}

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;

  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Refusing to start: expected a Postgres " +
        "connection string, e.g. postgres://user:pass@host:5432/routerx"
    );
  }

  return url;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export const config = {
  env: process.env.NODE_ENV ?? "development",
  isTest,
  isProduction: process.env.NODE_ENV === "production",
  port: Number(process.env.PORT) || 3000,

  jwtSecret: isTest ? TEST_SECRET : requireSecret(),

  database: {
    url: isTest
      ? process.env.TEST_DATABASE_URL ??
        "postgres://routerx:routerx@localhost:55432/routerx_test"
      : requireDatabaseUrl(),
    // One pool per process. The api serves requests concurrently; the workers
    // process one job at a time and need far less.
    poolSize: Number(process.env.DATABASE_POOL_SIZE) || 10,
    ssl: process.env.DATABASE_SSL === "true",
  },

  /**
   * Behind nginx or Cloudflare this must be set (e.g. TRUST_PROXY=1), or
   * every request appears to come from the proxy's IP and the per-IP rate
   * limits below collapse into a single shared bucket.
   */
  trustProxy: process.env.TRUST_PROXY ?? "",

  /** Empty means "any origin" — set CORS_ORIGINS in production. */
  corsOrigins: list(process.env.CORS_ORIGINS),

  /**
   * Which region this process probes from. Workers announce themselves under
   * this code, so bringing up a probe in a new location is a deploy rather
   * than a deploy plus a migration someone forgets.
   */
  region: process.env.REGION?.trim() || "default",
  regionName: process.env.REGION_NAME?.trim() || undefined,

  /** Public URL of the web app, used to build invite links. */
  appUrl: (process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, ""),

  otp: {
    length: 6,
    ttlMinutes: Number(process.env.OTP_TTL_MINUTES) || 10,
    maxAttempts: Number(process.env.OTP_MAX_ATTEMPTS) || 5,
  },

  retention: {
    probeDays: Number(process.env.PROBE_RETENTION_DAYS) || 30,
  },

  invites: {
    ttlHours: Number(process.env.INVITE_TTL_HOURS) || 72,
  },

  /**
   * Off by default. Plan limits are reported from day one but not applied
   * until this is set, so an existing deployment can look at real usage
   * before anything starts being refused.
   */
  enforceQuotas: process.env.ENFORCE_QUOTAS === "true",

  billing: {
    /** Billing endpoints return 503 until a secret key is present. */
    stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? "",
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    priceIds: {
      pro: process.env.STRIPE_PRICE_PRO ?? "",
      business: process.env.STRIPE_PRICE_BUSINESS ?? "",
    },
    get enabled(): boolean {
      return Boolean(process.env.STRIPE_SECRET_KEY);
    },
  },

  /**
   * Escape hatch for self-hosters who genuinely want to monitor a service on
   * their own LAN. Off by default: with it on, /probe and monitor creation
   * become an SSRF gadget pointed at the host's own network.
   */
  allowPrivateProbeTargets: process.env.ALLOW_PRIVATE_PROBE_TARGETS === "true",
};
