import { db } from "../../core/db/client";
import crypto from "crypto";
import nodemailer from "nodemailer";
import "dotenv/config";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

export async function requestMagicLink(email: string) {
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

  // 2. create login token
  const token = generateToken();

  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO sessions (user_id, token, expires_at)
    VALUES (?, ?, ?)
  `).run(user.id, token, expires);

  // 3. send magic link via email
  const baseUrl = process.env.BASE_URL || "http://localhost:3000";
  const link = `${baseUrl}/auth/verify?token=${token}`;

  // await transporter.sendMail({
  //   from: `"RouterX" <${process.env.GENERAL_FROM}>`,
  //   to: email,
  //   subject: "Your Magic Login Link",
  //   html: `
  //     <h2>Login to RouterX</h2>
  //     <p>Click below to sign in. This link expires in 15 minutes.</p>
  //     <a href="${link}">Sign In →</a>
  //     <p><small>If you didn't request this, ignore this email.</small></p>
  //   `,
  // });

  console.log(`📧 Magic link sent to ${email}`);

  return { ok: true, token };
}

export function verifyToken(token: string) {
  const session = db
    .prepare("SELECT * FROM sessions WHERE token = ?")
    .get(token) as any;

  if (!session) return null;

  if (new Date(session.expires_at) < new Date()) return null;

  return session;
}
