import crypto from "crypto";
import { execute, queryOne } from "../../core/db/client";
import { config } from "../../core/config";
import { emailLayout, sendMail } from "../../core/mail/mailer";
import { createSession } from "./session.service";
import {
  ensurePersonalOrganization,
  listUserOrganizations,
} from "../org/org.service";

interface UserRow {
  id: number;
  email: string;
  name: string | null;
}

interface OtpRow {
  id: number;
  user_id: number;
  code_hash: string;
  expires_at: Date;
  attempts: number;
}

/**
 * `Math.random()` is neither uniform nor unpredictable. That is tolerable for
 * a jitter value and not tolerable for something that IS the credential.
 */
function generateOtp(): string {
  const ceiling = 10 ** config.otp.length;
  return crypto.randomInt(0, ceiling).toString().padStart(config.otp.length, "0");
}

/**
 * Keyed hash, not a bare digest: a six-digit code has ~20 bits of entropy, so
 * an unkeyed SHA-256 of a leaked table falls to exhaustive search in
 * milliseconds. Binding the user id in stops one user's hash being replayed
 * against another's row.
 */
function hashOtp(userId: number, code: string): string {
  return crypto
    .createHmac("sha256", config.jwtSecret)
    .update(`${userId}:${code}`)
    .digest("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");

  if (bufferA.length !== bufferB.length) return false;

  return crypto.timingSafeEqual(bufferA, bufferB);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// users.email is CITEXT, so equality is already case-insensitive.
async function findUser(email: string): Promise<UserRow | undefined> {
  return queryOne<UserRow>(
    `SELECT id, email::text AS email, name FROM users WHERE email = $1`,
    [normalizeEmail(email)]
  );
}

async function sendOtpEmail(email: string, code: string): Promise<void> {
  await sendMail({
    to: email,
    subject: "Your RouteRX login code",
    html: emailLayout(
      "Sign in to RouteRX",
      `
        <p style="font-size:14px;color:#333">Your login code is:</p>
        <p style="font-size:30px;font-weight:600;letter-spacing:8px;margin:18px 0">${code}</p>
        <p style="font-size:13px;color:#666">
          It expires in ${config.otp.ttlMinutes} minutes and can be used once.
          If you didn't request it, you can ignore this email — nobody can
          sign in without the code.
        </p>
      `
    ),
  });
}

/**
 * Issue a login code. Creating the user on first request is the signup flow,
 * so this is deliberately callable for an unknown address — the abuse risk it
 * carries (mailing arbitrary inboxes) is handled by the rate limits on the
 * route, not here.
 */
export async function requestOtp(email: string): Promise<void> {
  const normalized = normalizeEmail(email);

  let user = await findUser(normalized);

  if (!user) {
    user = await queryOne<UserRow>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id, email::text AS email, name`,
      [normalized]
    );
  }

  // One live code per user: requesting a new one invalidates the previous, so
  // an attacker cannot accumulate a pool of valid codes to guess against.
  await execute(`DELETE FROM otp_codes WHERE user_id = $1`, [user!.id]);

  const code = generateOtp();
  const expiresAt = new Date(Date.now() + config.otp.ttlMinutes * 60 * 1000);

  await execute(
    `INSERT INTO otp_codes (user_id, code_hash, expires_at) VALUES ($1, $2, $3)`,
    [user!.id, hashOtp(user!.id, code), expiresAt]
  );

  await sendOtpEmail(normalized, code);

  // Never in production: the logs would be a list of live credentials.
  if (!config.isProduction) {
    console.log(`📧 OTP for ${normalized}: ${code}`);
  }
}

export interface LoginResult {
  token: string;
  user: { id: number; email: string; name: string | null };
  organizations: Array<{ id: number; name: string; slug: string; role: string }>;
}

/**
 * Verify a code and, on success, open a session.
 *
 * Returns null for every failure mode — unknown user, no code, expired code,
 * wrong code, too many attempts — so the caller cannot use the response to
 * learn which addresses are registered.
 */
export async function verifyOtp(
  email: string,
  code: string,
  context: { userAgent?: string | null; ip?: string | null } = {}
): Promise<LoginResult | null> {
  const user = await findUser(email);
  if (!user) return null;

  const row = await queryOne<OtpRow>(
    `SELECT * FROM otp_codes WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
    [user.id]
  );

  if (!row) return null;

  if (new Date(row.expires_at) < new Date()) {
    await execute(`DELETE FROM otp_codes WHERE id = $1`, [row.id]);
    return null;
  }

  if (row.attempts >= config.otp.maxAttempts) {
    await execute(`DELETE FROM otp_codes WHERE id = $1`, [row.id]);
    return null;
  }

  // Count the attempt before comparing, so a crash mid-request still costs
  // the caller something.
  await execute(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);

  if (!constantTimeEquals(row.code_hash, hashOtp(user.id, code.trim()))) {
    // Burn the code once the cap is reached rather than leaving it alive for
    // the rest of its TTL as a target for a fresh round of guesses.
    if (row.attempts + 1 >= config.otp.maxAttempts) {
      await execute(`DELETE FROM otp_codes WHERE id = $1`, [row.id]);
    }
    return null;
  }

  await execute(`DELETE FROM otp_codes WHERE id = $1`, [row.id]);

  // Everyone needs somewhere to put monitors; the first login creates it.
  await ensurePersonalOrganization(user.id, user.email);

  const { token } = await createSession(user.id, context);

  const organizations = await listUserOrganizations(user.id);

  return {
    token,
    user: { id: user.id, email: user.email, name: user.name },
    organizations: organizations.map((org) => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      role: org.role,
    })),
  };
}
