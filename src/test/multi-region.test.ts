import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CheckOutcome } from "../modules/probe/probe.service";

const { runCheck, dispatchAlert, getCertificateExpiry, announceIncident } = vi.hoisted(
  () => ({
    runCheck: vi.fn(),
    dispatchAlert: vi.fn().mockResolvedValue(undefined),
    getCertificateExpiry: vi.fn().mockResolvedValue(null),
    announceIncident: vi.fn().mockResolvedValue(undefined),
  })
);

vi.mock("../modules/probe/probe.service", () => ({ runCheck }));
vi.mock("../modules/notifications/notifier", () => ({ dispatchAlert }));
vi.mock("../domain/diagnostics/tls-expiry.checker", () => ({ getCertificateExpiry }));
vi.mock("../modules/status-pages/announcer", () => ({ announceIncident }));

import { processMonitor } from "../modules/monitor/check-runner";
import {
  createMonitor,
  createUserAndOrg,
  execute,
  query,
  queryOne,
  resetDatabase,
} from "./helpers/db";

const TIMINGS = { dns: 10, tcp: 20, tls: 30, ttfb: 40, total: 50 };

function outcome(partial: Partial<CheckOutcome> = {}): CheckOutcome {
  return {
    status: "UP",
    rootCause: null,
    detail: null,
    statusCode: 200,
    blocked: false,
    timings: TIMINGS,
    ...partial,
  };
}

const DOWN = outcome({ status: "DOWN", rootCause: "HTTP_5XX", detail: "HTTP 500", statusCode: 500 });

async function status(monitorId: number): Promise<string> {
  const row = await queryOne<{ confirmed_status: string }>(
    `SELECT confirmed_status FROM monitors WHERE id = $1`,
    [monitorId]
  );
  return row!.confirmed_status;
}

async function openIncidents(monitorId: number) {
  return query<{ affected_regions: string[] }>(
    `SELECT affected_regions FROM incidents
      WHERE monitor_id = $1 AND resolved_at IS NULL`,
    [monitorId]
  );
}

/** Drive `count` consecutive checks from one region. */
async function check(monitorId: number, region: string, count = 1) {
  for (let i = 0; i < count; i++) await processMonitor(monitorId, region);
}

describe("multi-region confirmation", () => {
  let orgId: number;
  let monitorId: number;

  beforeEach(async () => {
    await resetDatabase();
    ({ orgId } = await createUserAndOrg());

    await execute(
      `INSERT INTO regions (code, name) VALUES ('eu-west', 'EU West'), ('us-east', 'US East')
       ON CONFLICT DO NOTHING`
    );

    monitorId = await createMonitor(orgId);
    await execute(
      `UPDATE monitors SET regions = ARRAY['eu-west','us-east'] WHERE id = $1`,
      [monitorId]
    );
    await execute(
      `UPDATE alert_policies SET confirmations = 2 WHERE monitor_id = $1`,
      [monitorId]
    );

    runCheck.mockReset();
    dispatchAlert.mockClear();
    announceIncident.mockClear();
    getCertificateExpiry.mockClear();
    getCertificateExpiry.mockResolvedValue(null);
  });

  it("does not open an incident when only one region can't reach the site", async () => {
    runCheck.mockResolvedValue(DOWN);
    await check(monitorId, "eu-west", 5);

    runCheck.mockResolvedValue(outcome());
    await check(monitorId, "us-east", 5);

    expect(dispatchAlert).not.toHaveBeenCalled();
    expect(await openIncidents(monitorId)).toHaveLength(0);
    expect(await status(monitorId)).not.toBe("DOWN");

    // The failure is not discarded — it is visible per region.
    const region = await queryOne<{ status: string }>(
      `SELECT status FROM monitor_region_state WHERE monitor_id = $1 AND region = 'eu-west'`,
      [monitorId]
    );
    expect(region!.status).toBe("DOWN");
  });

  it("opens one incident once both regions agree, and records which", async () => {
    runCheck.mockResolvedValue(DOWN);

    await check(monitorId, "eu-west", 3);
    expect(dispatchAlert).not.toHaveBeenCalled();

    await check(monitorId, "us-east", 3);

    expect(await status(monitorId)).toBe("DOWN");

    const incidents = await openIncidents(monitorId);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].affected_regions.sort()).toEqual(["eu-west", "us-east"]);
    expect(dispatchAlert).toHaveBeenCalledTimes(1);
  });

  it("names the failing regions in the alert", async () => {
    runCheck.mockResolvedValue(DOWN);
    await check(monitorId, "eu-west", 3);
    await check(monitorId, "us-east", 3);

    const detail = dispatchAlert.mock.calls[0][0].detail as string;

    expect(detail).toContain("eu-west");
    expect(detail).toContain("2 of 2 regions");
  });

  it("stays down until every region recovers", async () => {
    runCheck.mockResolvedValue(DOWN);
    await check(monitorId, "eu-west", 3);
    await check(monitorId, "us-east", 3);

    runCheck.mockResolvedValue(outcome());
    await check(monitorId, "eu-west", 2);

    expect(await status(monitorId)).toBe("DOWN");
    expect(await openIncidents(monitorId)).toHaveLength(1);

    await check(monitorId, "us-east", 2);

    expect(await status(monitorId)).toBe("UP");
    expect(await openIncidents(monitorId)).toHaveLength(0);
  });

  it("tells the status page when an incident opens and when it resolves", async () => {
    runCheck.mockResolvedValue(DOWN);
    await check(monitorId, "eu-west", 3);
    await check(monitorId, "us-east", 3);

    runCheck.mockResolvedValue(outcome());
    await check(monitorId, "eu-west", 2);
    await check(monitorId, "us-east", 2);

    expect(announceIncident.mock.calls.map((call) => call[2])).toEqual([
      "opened",
      "resolved",
    ]);
  });

  it("keeps each region's probe history separate", async () => {
    runCheck.mockResolvedValue(outcome());
    await check(monitorId, "eu-west", 2);
    await check(monitorId, "us-east", 1);

    const rows = await query<{ region: string }>(
      `SELECT region FROM probe_results WHERE monitor_id = $1`,
      [monitorId]
    );

    expect(rows.filter((row) => row.region === "eu-west")).toHaveLength(2);
    expect(rows.filter((row) => row.region === "us-east")).toHaveLength(1);
  });

  it("falls back to a single vantage point when confirmations is 1", async () => {
    await execute(
      `UPDATE alert_policies SET confirmations = 1 WHERE monitor_id = $1`,
      [monitorId]
    );

    runCheck.mockResolvedValue(DOWN);
    await check(monitorId, "eu-west", 3);

    expect(await status(monitorId)).toBe("DOWN");
    expect(dispatchAlert).toHaveBeenCalledTimes(1);
  });

  it("resets a region's streak when a maintenance window starts", async () => {
    runCheck.mockResolvedValue(DOWN);
    await check(monitorId, "eu-west", 2);

    await execute(
      `INSERT INTO maintenance_windows (monitor_id, starts_at, ends_at, reason)
       VALUES ($1, now() - interval '1 hour', now() + interval '1 hour', 'deploy')`,
      [monitorId]
    );

    await check(monitorId, "eu-west", 1);

    const region = await queryOne<{ consecutive_failures: number }>(
      `SELECT consecutive_failures FROM monitor_region_state
        WHERE monitor_id = $1 AND region = 'eu-west'`,
      [monitorId]
    );

    expect(region!.consecutive_failures).toBe(0);
    expect(await status(monitorId)).toBe("MAINTENANCE");
  });
});
