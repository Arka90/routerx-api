import crypto from "crypto";
import { execute, query, queryOne } from "../../core/db/client";

/**
 * Sessions are opaque random tokens looked up in the database, not signed
 * claims.
 *
 * The previous design issued a 7-day JWT and logged out by deleting a cookie
 * client-side, so a stolen token stayed valid for a week with no way to stop
 * it. Verification now costs one indexed lookup, and that lookup is also
 * what makes revocation possible.
 */

const SESSION_TTL_DAYS = 30;
const TOKEN_BYTES = 32;

export interface SessionUser {
  id: number;
  email: string;
  name: string | null;
}

export interface AuthenticatedSession {
  user: SessionUser;
  sessionId: number;
}

export interface SessionSummary {
  id: number;
  user_agent: string | null;
  ip: string | null;
  last_used_at: Date | null;
  created_at: Date;
  expires_at: Date;
}

function hashToken(token: string): string {
  // The token is 256 bits of CSPRNG output, so a plain digest is enough —
  // there is nothing to brute force. Hashing means a database leak does not
  // hand over live sessions.
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  userId: number,
  context: { userAgent?: string | null; ip?: string | null } = {}
): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await execute(
    `INSERT INTO sessions (user_id, token_hash, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      userId,
      hashToken(token),
      context.userAgent?.slice(0, 500) ?? null,
      context.ip ?? null,
      expiresAt,
    ]
  );

  return { token, expiresAt };
}

export async function resolveSession(token: string): Promise<AuthenticatedSession | null> {
  const row = await queryOne<{
    session_id: number;
    id: number;
    email: string;
    name: string | null;
  }>(
    `SELECT s.id AS session_id, u.id, u.email, u.name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()`,
    [hashToken(token)]
  );

  if (!row) return null;

  // Fire-and-forget: a failed bookkeeping write must not fail the request.
  execute(`UPDATE sessions SET last_used_at = now() WHERE id = $1`, [
    row.session_id,
  ]).catch((error) => console.error("Could not update session last_used_at:", error));

  return {
    user: { id: row.id, email: row.email, name: row.name },
    sessionId: row.session_id,
  };
}

export async function revokeSession(userId: number, sessionId: number): Promise<boolean> {
  const changed = await execute(
    `UPDATE sessions SET revoked_at = now()
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [sessionId, userId]
  );

  return changed > 0;
}

/** Used by "sign out everywhere", and after any credential change. */
export async function revokeAllSessions(
  userId: number,
  exceptSessionId?: number
): Promise<number> {
  return execute(
    `UPDATE sessions SET revoked_at = now()
      WHERE user_id = $1
        AND revoked_at IS NULL
        AND ($2::bigint IS NULL OR id <> $2)`,
    [userId, exceptSessionId ?? null]
  );
}

export async function listSessions(userId: number): Promise<SessionSummary[]> {
  return query<SessionSummary>(
    `SELECT id, user_agent, ip, last_used_at, created_at, expires_at
       FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY last_used_at DESC NULLS LAST, created_at DESC`,
    [userId]
  );
}
