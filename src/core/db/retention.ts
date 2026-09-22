import { execute } from "./client";
import { config } from "../config";

export interface PruneSummary {
  probeResults: number;
  otpCodes: number;
  sessions: number;
  alertDeliveries: number;
}

/**
 * Delete data that has aged out.
 *
 * probe_results is the table that actually threatens the deployment: one
 * monitor on a 30-second interval writes ~2,880 rows a day and nothing ever
 * removed them. Incidents are deliberately kept — they are small, and they
 * are the history customers care about.
 */
export async function pruneExpiredData(): Promise<PruneSummary> {
  const cutoff = new Date(
    Date.now() - config.retention.probeDays * 24 * 60 * 60 * 1000
  );

  const probeResults = await execute(
    `DELETE FROM probe_results WHERE created_at < $1`,
    [cutoff]
  );

  const otpCodes = await execute(`DELETE FROM otp_codes WHERE expires_at < now()`);

  // Revoked sessions are kept for a week as an audit trail, then dropped.
  const sessions = await execute(
    `DELETE FROM sessions
      WHERE expires_at < now()
         OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')`
  );

  const alertDeliveries = await execute(
    `DELETE FROM alert_deliveries WHERE created_at < $1`,
    [cutoff]
  );

  // Expired invitations are not useful to anyone.
  await execute(
    `DELETE FROM org_invites
      WHERE accepted_at IS NULL AND expires_at < now() - interval '30 days'`
  );

  return { probeResults, otpCodes, sessions, alertDeliveries };
}
