import { db } from "./client";
import { config } from "../config";

export interface PruneSummary {
  probeResults: number;
  otpCodes: number;
  sessions: number;
}

/**
 * Delete data that has aged out.
 *
 * probe_results is the table that actually threatens the deployment: one
 * monitor on a 30-second interval writes ~2,880 rows a day and nothing ever
 * removed them. Incidents are deliberately kept — they are small, and they
 * are the history customers care about.
 */
export function pruneExpiredData(): PruneSummary {
  const cutoff = new Date(
    Date.now() - config.retention.probeDays * 24 * 60 * 60 * 1000
  ).toISOString();

  const now = new Date().toISOString();

  const probeResults = db
    .prepare(`DELETE FROM probe_results WHERE created_at < ?`)
    .run(cutoff).changes;

  const otpCodes = db
    .prepare(`DELETE FROM otp_codes WHERE expires_at < ?`)
    .run(now).changes;

  const sessions = db
    .prepare(`DELETE FROM sessions WHERE expires_at < ?`)
    .run(now).changes;

  // Large deletes leave the write-ahead log holding the freed pages; fold it
  // back into the main database so the -wal file does not grow without bound.
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch (error) {
    console.warn("WAL checkpoint after prune failed:", error);
  }

  return { probeResults, otpCodes, sessions };
}
