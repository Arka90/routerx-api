import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../core/db/client";
import { runMigrations } from "../core/db/migrate";
import { calculateUptime } from "../modules/incident/incident.service";

runMigrations();

const EMAIL = "uptime-test@example.com";

function seedMonitor(createdAt: Date): number {
  db.prepare("INSERT OR IGNORE INTO users (email) VALUES (?)").run(EMAIL);
  const user = db.prepare("SELECT id FROM users WHERE email = ?").get(EMAIL) as any;

  const result = db
    .prepare(
      `INSERT INTO monitors (user_id, url, interval_seconds, created_at)
       VALUES (?, ?, 60, ?)`
    )
    .run(user.id, `https://example.com/${Date.now()}-${Math.random()}`, createdAt.toISOString());

  return Number(result.lastInsertRowid);
}

function seedIncident(monitorId: number, startedAt: Date, resolvedAt: Date | null) {
  db.prepare(
    `INSERT INTO incidents (monitor_id, started_at, resolved_at) VALUES (?, ?, ?)`
  ).run(monitorId, startedAt.toISOString(), resolvedAt ? resolvedAt.toISOString() : null);
}

const HOUR = 60 * 60 * 1000;

describe("uptime calculation", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM users WHERE email = ?").run(EMAIL);
  });

  it("reports 100% for a monitor with no incidents", () => {
    const id = seedMonitor(new Date(Date.now() - 48 * HOUR));
    expect(calculateUptime(id, 24).uptime_percentage).toBe(100);
  });

  it("measures only the time since the monitor was created", () => {
    // Created 2 hours ago, down for 1 of them. Over a 30-day window the old
    // implementation divided by the full 720 hours and reported ~99.86%.
    const id = seedMonitor(new Date(Date.now() - 2 * HOUR));
    seedIncident(id, new Date(Date.now() - 2 * HOUR), new Date(Date.now() - HOUR));

    const result = calculateUptime(id, 720);

    expect(result.uptime_percentage).toBeGreaterThan(45);
    expect(result.uptime_percentage).toBeLessThan(55);
    expect(result.observed_hours).toBeLessThan(3);
    expect(result.window_hours).toBe(720);
  });

  it("counts an unresolved incident as downtime up to now", () => {
    const id = seedMonitor(new Date(Date.now() - 48 * HOUR));
    seedIncident(id, new Date(Date.now() - 12 * HOUR), null);

    const result = calculateUptime(id, 24);

    expect(result.uptime_percentage).toBeGreaterThan(45);
    expect(result.uptime_percentage).toBeLessThan(55);
  });

  it("clips an incident that began before the window", () => {
    const id = seedMonitor(new Date(Date.now() - 30 * 24 * HOUR));
    seedIncident(id, new Date(Date.now() - 48 * HOUR), new Date(Date.now() - 12 * HOUR));

    // Only the 12 hours inside the 24-hour window should count.
    const result = calculateUptime(id, 24);

    expect(result.uptime_percentage).toBeGreaterThan(45);
    expect(result.uptime_percentage).toBeLessThan(55);
  });
});
