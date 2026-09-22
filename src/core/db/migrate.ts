import { execute, withTransaction } from "./client";
import { migrations } from "./migrations";

/**
 * Arbitrary but fixed. Every process that might migrate takes this same
 * transaction-scoped advisory lock, so the api and both workers starting
 * together apply migrations one at a time instead of racing. Using the
 * _xact_ variant means the lock is released by COMMIT or ROLLBACK — there is
 * no path where a crashed migration leaves it held.
 */
const MIGRATION_LOCK_ID = 4_071_982;

export async function runMigrations(): Promise<void> {
  await execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);

    const { rows } = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations"
    );

    const done = new Set(rows.map((row) => row.version));
    const ran: string[] = [];

    for (const migration of migrations) {
      if (done.has(migration.version)) continue;

      // Postgres runs DDL transactionally, so a migration that fails halfway
      // leaves nothing behind to unpick by hand.
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [
        migration.version,
      ]);

      ran.push(migration.version);
    }

    return ran;
  });

  for (const version of applied) {
    console.log(`✔ Applied migration ${version}`);
  }

  console.log(
    applied.length === 0
      ? "Database schema up to date"
      : `Database schema up to date (${applied.length} migration(s) applied)`
  );
}
