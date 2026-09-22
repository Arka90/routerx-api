import { execute } from "./client";
import { config } from "../config";
import { PLAN_IDS, PLANS } from "../../modules/billing/plans";

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
 *
 * Retention is per plan, so a longer memory is something a plan can actually
 * sell. Workspaces with no subscription row, or a grandfathered one, fall
 * back to the instance-wide setting.
 */
export async function pruneExpiredData(): Promise<PruneSummary> {
  let probeResults = 0;

  for (const planId of PLAN_IDS) {
    probeResults += await execute(
      `DELETE FROM probe_results pr
        USING monitors m, subscriptions s
        WHERE pr.monitor_id = m.id
          AND s.org_id = m.org_id
          AND s.plan = $1
          AND s.grandfathered = false
          AND pr.created_at < now() - ($2::int * interval '1 day')`,
      [planId, PLANS[planId].limits.retentionDays]
    );
  }

  probeResults += await execute(
    `DELETE FROM probe_results pr
      USING monitors m
      LEFT JOIN subscriptions s ON s.org_id = m.org_id
      WHERE pr.monitor_id = m.id
        AND (s.org_id IS NULL OR s.grandfathered = true)
        AND pr.created_at < now() - ($1::int * interval '1 day')`,
    [config.retention.probeDays]
  );

  const otpCodes = await execute(`DELETE FROM otp_codes WHERE expires_at < now()`);

  // Revoked sessions are kept for a week as an audit trail, then dropped.
  const sessions = await execute(
    `DELETE FROM sessions
      WHERE expires_at < now()
         OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')`
  );

  const alertDeliveries = await execute(
    `DELETE FROM alert_deliveries WHERE created_at < now() - ($1::int * interval '1 day')`,
    [config.retention.probeDays]
  );

  // Expired invitations are not useful to anyone.
  await execute(
    `DELETE FROM org_invites
      WHERE accepted_at IS NULL AND expires_at < now() - interval '30 days'`
  );

  // Processed webhook ids only need to outlive the provider's retry window.
  await execute(
    `DELETE FROM billing_events WHERE processed_at < now() - interval '30 days'`
  );

  return { probeResults, otpCodes, sessions, alertDeliveries };
}
