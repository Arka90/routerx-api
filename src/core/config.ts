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

  /**
   * Behind nginx or Cloudflare this must be set (e.g. TRUST_PROXY=1), or
   * every request appears to come from the proxy's IP and the per-IP rate
   * limits below collapse into a single shared bucket.
   */
  trustProxy: process.env.TRUST_PROXY ?? "",

  /** Empty means "any origin" — set CORS_ORIGINS in production. */
  corsOrigins: list(process.env.CORS_ORIGINS),

  otp: {
    length: 6,
    ttlMinutes: Number(process.env.OTP_TTL_MINUTES) || 10,
    maxAttempts: Number(process.env.OTP_MAX_ATTEMPTS) || 5,
  },

  retention: {
    probeDays: Number(process.env.PROBE_RETENTION_DAYS) || 30,
  },

  /**
   * Escape hatch for self-hosters who genuinely want to monitor a service on
   * their own LAN. Off by default: with it on, /probe and monitor creation
   * become an SSRF gadget pointed at the host's own network.
   */
  allowPrivateProbeTargets: process.env.ALLOW_PRIVATE_PROBE_TARGETS === "true",
};
