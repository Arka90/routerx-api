import crypto from "crypto";
import nodemailer from "nodemailer";
import jwt from "jsonwebtoken";
import { db } from "../../core/db/client";
import { config } from "../../core/config";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

interface UserRow {
  id: number;
  email: string;
}

interface OtpRow {
  id: number;
  user_id: number;
  code_hash: string;
  expires_at: string;
  attempts: number;
}

/**
 * `Math.random()` is neither uniform nor unpredictable. That is tolerable for
 * a jitter value and not tolerable for something that IS the credential, so
 * this uses the CSPRNG. Six digits rather than four widens the space from
 * 9,000 to 1,000,000 — the attempt cap below is what actually stops a brute
 * force, but there is no reason to hand out the easier target.
 */
function generateOtp(): string {
  const ceiling = 10 ** config.otp.length;
  return crypto.randomInt(0, ceiling).toString().padStart(config.otp.length, "0");
}

/**
 * Keyed hash, not a bare digest: a six-digit code has ~20 bits of entropy, so
 * an unkeyed SHA-256 of a leaked table falls to an exhaustive search in
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

/**
 * Looked up case-insensitively so an account created as `Foo@example.com`
 * before emails were normalized is still reachable.
 */
function findUser(email: string): UserRow | undefined {
  return db
    .prepare(`SELECT id, email FROM users WHERE email = ? COLLATE NOCASE`)
    .get(normalizeEmail(email)) as UserRow | undefined;
}

async function sendOtpEmail(email: string, code: string) {
  await transporter.sendMail({
    from: `"RouteRX" <${process.env.GENERAL_FROM}>`,
    to: email,
    subject: "Your RouteRX login code",
    html: `
      <h2>Login to RouteRX</h2>
      <p>Your login code is: <strong style="font-size:20px;letter-spacing:3px">${code}</strong></p>
      <p>It expires in ${config.otp.ttlMinutes} minutes and can be used once.</p>
      <p><small>If you didn't request this, you can ignore this email — no one can sign in without the code.</small></p>
    `,
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

  let user = findUser(normalized);

  if (!user) {
    const result = db
      .prepare(`INSERT INTO users (email) VALUES (?)`)
      .run(normalized);

    user = { id: Number(result.lastInsertRowid), email: normalized };
  }

  // One live code per user: requesting a new one invalidates the previous,
  // so an attacker cannot accumulate a pool of valid codes to guess against.
  db.prepare(`DELETE FROM otp_codes WHERE user_id = ?`).run(user.id);

  const code = generateOtp();
  const expiresAt = new Date(
    Date.now() + config.otp.ttlMinutes * 60 * 1000
  ).toISOString();

  db.prepare(
    `INSERT INTO otp_codes (user_id, code_hash, expires_at) VALUES (?, ?, ?)`
  ).run(user.id, hashOtp(user.id, code), expiresAt);

  await sendOtpEmail(normalized, code);

  // Never in production: the logs would be a list of live credentials.
  if (!config.isProduction) {
    console.log(`📧 OTP for ${normalized}: ${code}`);
  }
}

/**
 * Verify a code and, on success, issue the session JWT.
 *
 * Returns null for every failure mode — unknown user, no code, expired code,
 * wrong code, too many attempts — so the caller cannot use the response to
 * learn which addresses are registered.
 */
export function verifyOtp(email: string, code: string): { token: string } | null {
  const user = findUser(email);
  if (!user) return null;

  const row = db
    .prepare(
      `SELECT * FROM otp_codes WHERE user_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(user.id) as OtpRow | undefined;

  if (!row) return null;

  if (new Date(row.expires_at) < new Date()) {
    db.prepare(`DELETE FROM otp_codes WHERE id = ?`).run(row.id);
    return null;
  }

  if (row.attempts >= config.otp.maxAttempts) {
    db.prepare(`DELETE FROM otp_codes WHERE id = ?`).run(row.id);
    return null;
  }

  // Count the attempt before comparing. If the comparison throws or the
  // process dies mid-request, the attempt still cost the caller something.
  db.prepare(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`).run(row.id);

  const matches = constantTimeEquals(
    row.code_hash,
    hashOtp(user.id, code.trim())
  );

  if (!matches) {
    // Burn the code once the cap is reached, rather than leaving it alive for
    // the rest of its TTL as a target for a fresh round of guesses.
    if (row.attempts + 1 >= config.otp.maxAttempts) {
      db.prepare(`DELETE FROM otp_codes WHERE id = ?`).run(row.id);
    }
    return null;
  }

  // Single use.
  db.prepare(`DELETE FROM otp_codes WHERE id = ?`).run(row.id);

  const token = jwt.sign(
    { id: user.id, email: user.email },
    config.jwtSecret,
    { expiresIn: "7d" }
  );

  return { token };
}
