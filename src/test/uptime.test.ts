import { describe, it, expect, beforeEach } from "vitest";
import { calculateUptime } from "../modules/incident/incident.service";
import {
  addIncident,
  createMonitor,
  createUserAndOrg,
  resetDatabase,
} from "./helpers/db";

const HOUR = 60 * 60 * 1000;

describe("uptime calculation", () => {
  let orgId: number;

  beforeEach(async () => {
    await resetDatabase();
    ({ orgId } = await createUserAndOrg());
  });

  it("reports 100% for a monitor with no incidents", async () => {
    const id = await createMonitor(orgId);
    const result = await calculateUptime(id, 24);

    expect(result.uptime_percentage).toBe(100);
    expect(result.total_downtime_seconds).toBe(0);
  });

  it("measures only the time since the monitor was created", async () => {
    // Created 2 hours ago, down for 1 of them. Dividing by the full 30-day
    // window would report ~99.86%.
    const id = await createMonitor(orgId, {
      created_at: new Date(Date.now() - 2 * HOUR),
    });
    await addIncident(id, new Date(Date.now() - 2 * HOUR), new Date(Date.now() - HOUR));

    const result = await calculateUptime(id, 720);

    expect(result.uptime_percentage).toBeGreaterThan(45);
    expect(result.uptime_percentage).toBeLessThan(55);
    expect(result.observed_hours).toBeLessThan(3);
    expect(result.window_hours).toBe(720);
  });

  it("counts an unresolved incident as downtime up to now", async () => {
    const id = await createMonitor(orgId);
    await addIncident(id, new Date(Date.now() - 12 * HOUR), null);

    const result = await calculateUptime(id, 24);

    expect(result.uptime_percentage).toBeGreaterThan(45);
    expect(result.uptime_percentage).toBeLessThan(55);
  });

  it("clips an incident that began before the window", async () => {
    const id = await createMonitor(orgId);
    await addIncident(
      id,
      new Date(Date.now() - 48 * HOUR),
      new Date(Date.now() - 12 * HOUR)
    );

    // Only the 12 hours inside the 24-hour window should count.
    const result = await calculateUptime(id, 24);

    expect(result.uptime_percentage).toBeGreaterThan(45);
    expect(result.uptime_percentage).toBeLessThan(55);
  });

  it("never reports a negative percentage when downtime spans the window", async () => {
    const id = await createMonitor(orgId);
    await addIncident(id, new Date(Date.now() - 72 * HOUR), null);

    const result = await calculateUptime(id, 24);

    expect(result.uptime_percentage).toBe(0);
  });
});
