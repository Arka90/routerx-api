import { db } from "../../core/db/client";
import nodemailer from "nodemailer";
import "dotenv/config";
import jwt from "jsonwebtoken";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

function generateOTP() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

export async function requestOtp(email: string) {
  // 1. find or create user
  let user = db
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(email) as any;

  if (!user) {
    const result = db
      .prepare("INSERT INTO users (email) VALUES (?)")
      .run(email);

    user = { id: result.lastInsertRowid, email };
  }

  // Delete previous OTP sessions for this user to avoid clutter
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND token LIKE 'OTP-%'").run(user.id);

  // 2. create OTP token
  const otp = generateOTP();
  const token = `OTP-${user.id}-${otp}`;
  // 15 minutes expiry
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO sessions (user_id, token, expires_at)
    VALUES (?, ?, ?)
  `).run(user.id, token, expires);

  // 3. send OTP via email
  await transporter.sendMail({
    from: `"RouteRX" <${process.env.GENERAL_FROM}>`,
    to: email,
    subject: "Your RouteRX Login OTP",
    html: `
      <h2>Login to RouteRX</h2>
      <p>Your OTP is: <strong>${otp}</strong></p>
      <p>This OTP expires in 15 minutes.</p>
      <p><small>If you didn't request this, ignore this email.</small></p>
    `,
  });

  console.log(`📧 OTP sent to ${email}: ${otp}`);

  return { ok: true };
}

export function verifyOtp(email: string, otp: string) {
  // Find user by email to construct token string
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as any;
  if (!user) return null;

  const tokenStr = `OTP-${user.id}-${otp}`;

  const session = db
    .prepare("SELECT * FROM sessions WHERE token = ?")
    .get(tokenStr) as any;

  if (!session) return null;

  if (new Date(session.expires_at) < new Date()) {
    // Optional: cleanup expired Token
    db.prepare("DELETE FROM sessions WHERE token = ?").run(tokenStr);
    return null;
  }

  // OTP verified, issue JWT token valid for 7 days
  const jwtSecret = process.env.JWT_SECRET || "fallback_secret_dont_use_in_prod";
  const jwtToken = jwt.sign({ id: user.id, email: user.email }, jwtSecret, { expiresIn: "7d" });

  // Delete the OTP session as it's been used successfully
  db.prepare("DELETE FROM sessions WHERE token = ?").run(tokenStr);

  return { token: jwtToken };
}
