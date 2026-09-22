import { describe, it, expect, beforeEach, vi } from "vitest";

// The service sends mail on every request; the transport is stubbed so the
// suite exercises the code logic without an SMTP server. vi.mock is hoisted
// above the imports, so the spy has to be hoisted with it.
const { sendMail } = vi.hoisted(() => ({
  sendMail: vi.fn().mockResolvedValue({}),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail }) },
}));

import { db } from "../core/db/client";
import { runMigrations } from "../core/db/migrate";
import { requestOtp, verifyOtp } from "../modules/auth/auth.service";
import { config } from "../core/config";

runMigrations();

const EMAIL = "otp-test@example.com";

/** Pull the code out of the stubbed email we just "sent". */
function lastCode(): string {
  const calls = sendMail.mock.calls;
  const html = calls[calls.length - 1][0].html as string;
  const match = html.match(/(\d{6})/);
  if (!match) throw new Error("no code in the sent email");
  return match[1];
}

function userId(): number {
  return (db.prepare("SELECT id FROM users WHERE email = ?").get(EMAIL) as any).id;
}

describe("login codes", () => {
  beforeEach(() => {
    sendMail.mockClear();
    db.prepare("DELETE FROM users WHERE email = ?").run(EMAIL);
  });

  it("issues a code of the configured length and never stores it in the clear", async () => {
    await requestOtp(EMAIL);

    const code = lastCode();
    expect(code).toHaveLength(config.otp.length);

    const row = db
      .prepare("SELECT code_hash FROM otp_codes WHERE user_id = ?")
      .get(userId()) as any;

    expect(row.code_hash).not.toContain(code);
    expect(row.code_hash).toHaveLength(64); // sha256 hex
  });

  it("accepts the right code once, then refuses to replay it", async () => {
    await requestOtp(EMAIL);
    const code = lastCode();

    expect(verifyOtp(EMAIL, code)).not.toBeNull();
    expect(verifyOtp(EMAIL, code)).toBeNull();
  });

  it("burns the code after the attempt cap, so the right code no longer works", async () => {
    await requestOtp(EMAIL);
    const code = lastCode();
    const wrong = code === "000000" ? "111111" : "000000";

    for (let attempt = 0; attempt < config.otp.maxAttempts; attempt++) {
      expect(verifyOtp(EMAIL, wrong)).toBeNull();
    }

    expect(verifyOtp(EMAIL, code)).toBeNull();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM otp_codes WHERE user_id = ?").get(userId())
    ).toEqual({ n: 0 });
  });

  it("invalidates the previous code when a new one is requested", async () => {
    await requestOtp(EMAIL);
    const first = lastCode();

    await requestOtp(EMAIL);
    const second = lastCode();

    expect(verifyOtp(EMAIL, first)).toBeNull();
    expect(verifyOtp(EMAIL, second)).not.toBeNull();
  });

  it("rejects an expired code", async () => {
    await requestOtp(EMAIL);
    const code = lastCode();

    db.prepare("UPDATE otp_codes SET expires_at = ? WHERE user_id = ?").run(
      new Date(Date.now() - 1000).toISOString(),
      userId()
    );

    expect(verifyOtp(EMAIL, code)).toBeNull();
  });

  it("treats the address case-insensitively", async () => {
    await requestOtp(EMAIL.toUpperCase());
    expect(verifyOtp(EMAIL, lastCode())).not.toBeNull();
  });

  it("returns null for an address that was never issued a code", () => {
    expect(verifyOtp("nobody@example.com", "123456")).toBeNull();
  });
});
