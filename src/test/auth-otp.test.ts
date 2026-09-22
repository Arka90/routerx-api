import { describe, it, expect, beforeEach, vi } from "vitest";

// vi.mock is hoisted above the imports, so the spy has to be hoisted with it.
const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn().mockResolvedValue({}) }));

vi.mock("../core/mail/mailer", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendMail,
}));

import { requestOtp, verifyOtp } from "../modules/auth/auth.service";
import { resolveSession } from "../modules/auth/session.service";
import { config } from "../core/config";
import { query, queryOne, resetDatabase } from "./helpers/db";

const EMAIL = "otp-test@example.com";

/** Pull the code out of the stubbed email we just "sent". */
function lastCode(): string {
  const calls = sendMail.mock.calls;
  const html = calls[calls.length - 1][0].html as string;
  const match = html.match(/(\d{6})/);
  if (!match) throw new Error("no code in the sent email");
  return match[1];
}

async function userId(): Promise<number> {
  const row = await queryOne<{ id: number }>(
    `SELECT id FROM users WHERE email = $1`,
    [EMAIL]
  );
  return row!.id;
}

describe("login codes", () => {
  beforeEach(async () => {
    await resetDatabase();
    sendMail.mockClear();
  });

  it("issues a code of the configured length and never stores it in the clear", async () => {
    await requestOtp(EMAIL);

    const code = lastCode();
    expect(code).toHaveLength(config.otp.length);

    const rows = await query<{ code_hash: string }>(
      `SELECT code_hash FROM otp_codes WHERE user_id = $1`,
      [await userId()]
    );

    expect(rows[0].code_hash).not.toContain(code);
    expect(rows[0].code_hash).toHaveLength(64); // sha256 hex
  });

  it("accepts the right code once, then refuses to replay it", async () => {
    await requestOtp(EMAIL);
    const code = lastCode();

    expect(await verifyOtp(EMAIL, code)).not.toBeNull();
    expect(await verifyOtp(EMAIL, code)).toBeNull();
  });

  it("burns the code after the attempt cap, so the right code no longer works", async () => {
    await requestOtp(EMAIL);
    const code = lastCode();
    const wrong = code === "000000" ? "111111" : "000000";

    for (let attempt = 0; attempt < config.otp.maxAttempts; attempt++) {
      expect(await verifyOtp(EMAIL, wrong)).toBeNull();
    }

    expect(await verifyOtp(EMAIL, code)).toBeNull();

    const remaining = await query(`SELECT id FROM otp_codes WHERE user_id = $1`, [
      await userId(),
    ]);
    expect(remaining).toHaveLength(0);
  });

  it("invalidates the previous code when a new one is requested", async () => {
    await requestOtp(EMAIL);
    const first = lastCode();

    await requestOtp(EMAIL);
    const second = lastCode();

    expect(await verifyOtp(EMAIL, first)).toBeNull();
    expect(await verifyOtp(EMAIL, second)).not.toBeNull();
  });

  it("rejects an expired code", async () => {
    await requestOtp(EMAIL);
    const code = lastCode();

    await query(`UPDATE otp_codes SET expires_at = now() - interval '1 minute'`);

    expect(await verifyOtp(EMAIL, code)).toBeNull();
  });

  it("treats the address case-insensitively", async () => {
    await requestOtp(EMAIL.toUpperCase());
    expect(await verifyOtp(EMAIL, lastCode())).not.toBeNull();
  });

  it("returns null for an address that was never issued a code", async () => {
    expect(await verifyOtp("nobody@example.com", "123456")).toBeNull();
  });

  it("gives a first-time user a workspace they own", async () => {
    await requestOtp(EMAIL);
    const result = await verifyOtp(EMAIL, lastCode());

    expect(result!.organizations).toHaveLength(1);
    expect(result!.organizations[0].role).toBe("owner");
  });

  it("issues a session token that resolves to the user", async () => {
    await requestOtp(EMAIL);
    const result = await verifyOtp(EMAIL, lastCode());

    const session = await resolveSession(result!.token);

    expect(session).not.toBeNull();
    expect(session!.user.email).toBe(EMAIL);
  });

  it("does not put the raw session token in the database", async () => {
    await requestOtp(EMAIL);
    const result = await verifyOtp(EMAIL, lastCode());

    const rows = await query<{ token_hash: string }>(`SELECT token_hash FROM sessions`);

    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(result!.token);
  });
});
