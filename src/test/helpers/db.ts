import { execute, query, queryOne } from "../../core/db/client";
import { runMigrations } from "../../core/db/migrate";

let migrated = false;

/**
 * Migrate once per worker, then clear between tests. Vitest runs each file in
 * its own worker, and each worker holds its own in-process database, so
 * files cannot see one another's fixtures.
 */
export async function resetDatabase(): Promise<void> {
  if (!migrated) {
    await runMigrations();
    migrated = true;
  }

  // CASCADE reaches everything hanging off users and organizations.
  await execute(
    `TRUNCATE users, organizations, monitors, incidents, probe_results,
              notification_channels, alert_deliveries, sessions, otp_codes,
              org_invites, maintenance_windows
     RESTART IDENTITY CASCADE`
  );
}

export interface Fixture {
  userId: number;
  email: string;
  orgId: number;
}

export async function createUserAndOrg(
  email = "owner@example.com",
  orgName = "Test workspace"
): Promise<Fixture> {
  const user = await queryOne<{ id: number }>(
    `INSERT INTO users (email) VALUES ($1) RETURNING id`,
    [email]
  );

  const org = await queryOne<{ id: number }>(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
    [orgName, `test-${Math.random().toString(36).slice(2, 10)}`]
  );

  await execute(
    `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [org!.id, user!.id]
  );

  return { userId: user!.id, email, orgId: org!.id };
}

export async function createMonitor(
  orgId: number,
  overrides: Record<string, unknown> = {}
): Promise<number> {
  const url = (overrides.url as string) ?? `https://example.com/${Math.random()}`;

  const row = await queryOne<{ id: number }>(
    `INSERT INTO monitors (org_id, url, interval_seconds, created_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      orgId,
      url,
      (overrides.interval_seconds as number) ?? 60,
      (overrides.created_at as Date) ?? new Date(Date.now() - 30 * 24 * 3600 * 1000),
    ]
  );

  await execute(`INSERT INTO alert_policies (monitor_id) VALUES ($1)`, [row!.id]);

  return row!.id;
}

export async function addIncident(
  monitorId: number,
  startedAt: Date,
  resolvedAt: Date | null
): Promise<void> {
  await execute(
    `INSERT INTO incidents (monitor_id, started_at, resolved_at, duration_seconds)
     VALUES ($1, $2, $3, $4)`,
    [
      monitorId,
      startedAt,
      resolvedAt,
      resolvedAt
        ? Math.round((resolvedAt.getTime() - startedAt.getTime()) / 1000)
        : null,
    ]
  );
}

export { execute, query, queryOne };
