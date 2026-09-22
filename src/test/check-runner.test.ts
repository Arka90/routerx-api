import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CheckOutcome } from "../modules/probe/probe.service";

const { runCheck, dispatchAlert, getCertificateExpiry } = vi.hoisted(() => ({
  runCheck: vi.fn(),
  dispatchAlert: vi.fn().mockResolvedValue(undefined),
  getCertificateExpiry: vi.fn().mockResolvedValue(null),
}));

vi.mock("../modules/probe/probe.service", () => ({ runCheck }));
vi.mock("../modules/notifications/notifier", () => ({ dispatchAlert }));
vi.mock("../domain/diagnostics/tls-expiry.checker", () => ({ getCertificateExpiry }));

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

const DOWN = outcome({
  status: "DOWN",
  rootCause: "HTTP_5XX",
  detail: "HTTP 500 (expected a 2xx or 3xx)",
  statusCode: 500,
});

async function status(monitorId: number): Promise<string> {
  const row = await queryOne<{ confirmed_status: string }>(
    `SELECT confirmed_status FROM monitors WHERE id = $1`,
    [monitorId]
  );
  return row!.confirmed_status;
}

async function openIncidentCount(monitorId: number): Promise<number> {
  const rows = await query(
    `SELECT id FROM incidents WHERE monitor_id = $1 AND resolved_at IS NULL`,
    [monitorId]
  );
  return rows.length;
}

function alertTypes(): string[] {
  return dispatchAlert.mock.calls.map((call) => call[0].type);
}

describe("check state machine", () => {
  let orgId: number;
  let monitorId: number;

  beforeEach(async () => {
    await resetDatabase();
    ({ orgId } = await createUserAndOrg());
    monitorId = await createMonitor(orgId);
    runCheck.mockReset();
    dispatchAlert.mockClear();
    getCertificateExpiry.mockClear();
    getCertificateExpiry.mockResolvedValue(null);
  });

  it("does not alert before the failure threshold is reached", async () => {
    runCheck.mockResolvedValue(DOWN);

    await processMonitor(monitorId);
    await processMonitor(monitorId);

    expect(dispatchAlert).not.toHaveBeenCalled();
    expect(await status(monitorId)).not.toBe("DOWN");
    expect(await openIncidentCount(monitorId)).toBe(0);
  });

  it("confirms down on the third failure and alerts exactly once", async () => {
    runCheck.mockResolvedValue(DOWN);

    for (let i = 0; i < 5; i++) await processMonitor(monitorId);

    expect(await status(monitorId)).toBe("DOWN");
    expect(await openIncidentCount(monitorId)).toBe(1);
    expect(alertTypes()).toEqual(["DOWN"]);
  });

  it("honours a per-monitor failure threshold", async () => {
    await execute(
      `UPDATE alert_policies SET failure_threshold = 1 WHERE monitor_id = $1`,
      [monitorId]
    );
    runCheck.mockResolvedValue(DOWN);

    await processMonitor(monitorId);

    expect(await status(monitorId)).toBe("DOWN");
    expect(alertTypes()).toEqual(["DOWN"]);
  });

  it("recovers after the recovery threshold and resolves the incident", async () => {
    runCheck.mockResolvedValue(DOWN);
    for (let i = 0; i < 3; i++) await processMonitor(monitorId);

    runCheck.mockResolvedValue(outcome());
    await processMonitor(monitorId);
    expect(await status(monitorId)).toBe("DOWN"); // one success is not enough

    await processMonitor(monitorId);

    expect(await status(monitorId)).toBe("UP");
    expect(await openIncidentCount(monitorId)).toBe(0);
    expect(alertTypes()).toEqual(["DOWN", "UP"]);
  });

  it("records a resolved incident's duration", async () => {
    runCheck.mockResolvedValue(DOWN);
    for (let i = 0; i < 3; i++) await processMonitor(monitorId);

    runCheck.mockResolvedValue(outcome());
    for (let i = 0; i < 2; i++) await processMonitor(monitorId);

    const incident = await queryOne<{ duration_seconds: number }>(
      `SELECT duration_seconds FROM incidents WHERE monitor_id = $1`,
      [monitorId]
    );

    expect(incident!.duration_seconds).toBeGreaterThanOrEqual(0);
  });

  it("treats SLOW as healthy unless the policy opts in", async () => {
    runCheck.mockResolvedValue(
      outcome({ status: "SLOW", rootCause: "SLOW_RESPONSE", detail: "Responded in 3000ms" })
    );

    for (let i = 0; i < 5; i++) await processMonitor(monitorId);

    expect(dispatchAlert).not.toHaveBeenCalled();
    expect(await status(monitorId)).toBe("UP");
  });

  it("marks a monitor DEGRADED when alert_on_slow is enabled", async () => {
    await execute(
      `UPDATE alert_policies SET alert_on_slow = true WHERE monitor_id = $1`,
      [monitorId]
    );

    runCheck.mockResolvedValue(
      outcome({ status: "SLOW", rootCause: "SLOW_RESPONSE", detail: "Responded in 3000ms" })
    );

    for (let i = 0; i < 3; i++) await processMonitor(monitorId);

    expect(await status(monitorId)).toBe("DEGRADED");
    expect(alertTypes()).toEqual(["DEGRADED"]);
    expect(await openIncidentCount(monitorId)).toBe(1);
  });

  it("stays quiet while muted, but still tracks the incident", async () => {
    await execute(
      `UPDATE alert_policies SET muted_until = now() + interval '1 hour' WHERE monitor_id = $1`,
      [monitorId]
    );
    runCheck.mockResolvedValue(DOWN);

    for (let i = 0; i < 3; i++) await processMonitor(monitorId);

    expect(dispatchAlert).not.toHaveBeenCalled();
    expect(await status(monitorId)).toBe("DOWN");
    expect(await openIncidentCount(monitorId)).toBe(1);
  });

  it("re-notifies on the configured cadence while still down", async () => {
    await execute(
      `UPDATE alert_policies SET renotify_minutes = 30 WHERE monitor_id = $1`,
      [monitorId]
    );
    runCheck.mockResolvedValue(DOWN);

    for (let i = 0; i < 3; i++) await processMonitor(monitorId);
    expect(alertTypes()).toEqual(["DOWN"]);

    // Not due yet.
    await processMonitor(monitorId);
    expect(alertTypes()).toEqual(["DOWN"]);

    await execute(
      `UPDATE incidents SET last_notified_at = now() - interval '31 minutes'
        WHERE monitor_id = $1 AND resolved_at IS NULL`,
      [monitorId]
    );

    await processMonitor(monitorId);
    expect(alertTypes()).toEqual(["DOWN", "REMINDER"]);
  });

  it("stops re-notifying once the incident is acknowledged", async () => {
    await execute(
      `UPDATE alert_policies SET renotify_minutes = 30 WHERE monitor_id = $1`,
      [monitorId]
    );
    runCheck.mockResolvedValue(DOWN);

    for (let i = 0; i < 3; i++) await processMonitor(monitorId);

    await execute(
      `UPDATE incidents
          SET last_notified_at = now() - interval '31 minutes',
              acknowledged_at = now()
        WHERE monitor_id = $1 AND resolved_at IS NULL`,
      [monitorId]
    );

    await processMonitor(monitorId);

    expect(alertTypes()).toEqual(["DOWN"]);
  });

  it("neither counts failures nor alerts during a maintenance window", async () => {
    await execute(
      `INSERT INTO maintenance_windows (monitor_id, starts_at, ends_at, reason)
       VALUES ($1, now() - interval '1 hour', now() + interval '1 hour', 'deploy')`,
      [monitorId]
    );
    runCheck.mockResolvedValue(DOWN);

    for (let i = 0; i < 5; i++) await processMonitor(monitorId);

    expect(dispatchAlert).not.toHaveBeenCalled();
    expect(await status(monitorId)).toBe("MAINTENANCE");
    expect(await openIncidentCount(monitorId)).toBe(0);
  });

  it("skips a paused monitor entirely", async () => {
    await execute(`UPDATE monitors SET paused = true WHERE id = $1`, [monitorId]);
    runCheck.mockResolvedValue(DOWN);

    await processMonitor(monitorId);

    expect(runCheck).not.toHaveBeenCalled();
    expect(await query(`SELECT id FROM probe_results`)).toHaveLength(0);
  });

  it("records every probe with its root cause", async () => {
    runCheck.mockResolvedValue(DOWN);
    await processMonitor(monitorId);

    const probes = await query<{ status: string; root_cause: string; ttfb: number }>(
      `SELECT status, root_cause, ttfb FROM probe_results WHERE monitor_id = $1`,
      [monitorId]
    );

    expect(probes).toHaveLength(1);
    expect(probes[0].status).toBe("DOWN");
    expect(probes[0].root_cause).toBe("HTTP_5XX");
    expect(probes[0].ttfb).toBe(40);
  });

  it("does not fetch a certificate for a target the SSRF guard refused", async () => {
    runCheck.mockResolvedValue(
      outcome({ status: "DOWN", rootCause: "BLOCKED_TARGET", blocked: true, statusCode: null })
    );

    await processMonitor(monitorId);

    expect(getCertificateExpiry).not.toHaveBeenCalled();
  });

  it("ignores a job for a monitor that has been deleted", async () => {
    await execute(`DELETE FROM monitors WHERE id = $1`, [monitorId]);

    await expect(processMonitor(monitorId)).resolves.toBeUndefined();
    expect(runCheck).not.toHaveBeenCalled();
  });
});
