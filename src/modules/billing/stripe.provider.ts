import crypto from "crypto";
import https from "https";
import { config } from "../../core/config";

/**
 * A thin Stripe client over plain HTTPS.
 *
 * The official SDK is a large dependency for three endpoints and a signature
 * check, and it would sit in the same process as the probe workers. This
 * covers exactly what the billing flow needs and nothing else.
 *
 * The host is hardcoded, so unlike the probe and webhook paths there is no
 * user-supplied destination here and no SSRF surface to guard.
 */

const STRIPE_HOST = "api.stripe.com";
const STRIPE_VERSION = "2024-06-20";

export class StripeError extends Error {}

/** Stripe takes form-encoded bodies with bracket notation for nesting. */
function encode(params: Record<string, unknown>, prefix = ""): string[] {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;

    const name = prefix ? `${prefix}[${key}]` : key;

    if (typeof value === "object" && !Array.isArray(value)) {
      parts.push(...encode(value as Record<string, unknown>, name));
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === "object") {
          parts.push(...encode(item as Record<string, unknown>, `${name}[${index}]`));
        } else {
          parts.push(`${encodeURIComponent(`${name}[${index}]`)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }

  return parts;
}

async function stripeRequest<T>(
  path: string,
  params: Record<string, unknown>
): Promise<T> {
  if (!config.billing.stripeSecretKey) {
    throw new StripeError("Billing is not configured");
  }

  const body = encode(params).join("&");

  return new Promise<T>((resolve, reject) => {
    const req = https.request(
      {
        hostname: STRIPE_HOST,
        path,
        method: "POST",
        timeout: 15_000,
        headers: {
          Authorization: `Bearer ${config.billing.stripeSecretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          "Stripe-Version": STRIPE_VERSION,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];

        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");

          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            return reject(new StripeError(`Stripe returned unparseable response`));
          }

          const status = res.statusCode ?? 0;

          if (status < 200 || status >= 300) {
            const message =
              (parsed as { error?: { message?: string } })?.error?.message ??
              `Stripe returned HTTP ${status}`;
            return reject(new StripeError(message));
          }

          resolve(parsed as T);
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new StripeError("Stripe request timed out"));
    });

    req.on("error", (error) => reject(new StripeError(error.message)));
    req.write(body);
    req.end();
  });
}

export async function createCheckoutSession(options: {
  orgId: number;
  plan: string;
  priceId: string;
  customerEmail: string;
  customerId: string | null;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ id: string; url: string }> {
  return stripeRequest("/v1/checkout/sessions", {
    mode: "subscription",
    success_url: options.successUrl,
    cancel_url: options.cancelUrl,
    // Both, deliberately: the session metadata is what the immediate
    // checkout.session.completed carries, and the subscription metadata is
    // what every later subscription.* event carries.
    metadata: { org_id: String(options.orgId), plan: options.plan },
    subscription_data: {
      metadata: { org_id: String(options.orgId), plan: options.plan },
    },
    line_items: [{ price: options.priceId, quantity: 1 }],
    ...(options.customerId
      ? { customer: options.customerId }
      : { customer_email: options.customerEmail }),
  });
}

export async function createPortalSession(
  customerId: string,
  returnUrl: string
): Promise<{ url: string }> {
  return stripeRequest("/v1/billing_portal/sessions", {
    customer: customerId,
    return_url: returnUrl,
  });
}

/** Tolerate clock skew, but not an indefinitely replayable request. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Verify a Stripe webhook signature.
 *
 * The header looks like `t=1690000000,v1=abc...,v1=def...`. The signed
 * payload is `${timestamp}.${rawBody}`, which is why the route has to read
 * the raw body rather than a re-serialised JSON object — key order would
 * differ and every signature would fail.
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
  now: number = Date.now()
): boolean {
  if (!signatureHeader || !secret) return false;

  const parts = signatureHeader.split(",").map((part) => part.trim());

  let timestamp: string | null = null;
  const signatures: string[] = [];

  for (const part of parts) {
    const [key, value] = part.split("=", 2);
    if (key === "t") timestamp = value;
    else if (key === "v1" && value) signatures.push(value);
  }

  if (!timestamp || signatures.length === 0) return false;

  const age = Math.abs(now / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) return false;

  const payload = Buffer.concat([
    Buffer.from(`${timestamp}.`, "utf8"),
    Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8"),
  ]);

  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");

  return signatures.some((signature) => {
    const candidate = Buffer.from(signature, "utf8");
    if (candidate.length !== expectedBuffer.length) return false;
    return crypto.timingSafeEqual(candidate, expectedBuffer);
  });
}
