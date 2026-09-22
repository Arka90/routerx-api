import { db } from "./client";

export function runMigrations() {

  db.exec(`PRAGMA foreign_keys = ON;`);

  // USERS
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // SESSIONS
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // OTP CODES
  //
  // Login codes used to live in `sessions` as the literal string
  // "OTP-<userId>-<code>", which meant anyone with read access to the table
  // could log in as anyone. They now live here as a keyed hash, with an
  // attempt counter so a wrong code cannot be retried indefinitely.
  db.exec(`
    CREATE TABLE IF NOT EXISTS otp_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // MONITORS
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      interval_seconds INTEGER DEFAULT 60,
      next_check_at DATETIME,
      confirmed_status TEXT DEFAULT 'UP',
      consecutive_failures INTEGER DEFAULT 0,
      consecutive_successes INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // PROBE RESULTS
  db.exec(`
    CREATE TABLE IF NOT EXISTS probe_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER,
      dns INTEGER,
      tcp INTEGER,
      tls INTEGER,
      ttfb INTEGER,
      status TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE SET NULL
    );
  `);

  // INCIDENTS
  db.exec(`
    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      started_at DATETIME NOT NULL,
      resolved_at DATETIME,
      duration_seconds INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );
  `);

  // MAINTENANCE WINDOWS
  db.exec(`
    CREATE TABLE IF NOT EXISTS maintenance_windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      starts_at DATETIME NOT NULL,
      ends_at DATETIME NOT NULL,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );
  `);

  // Safe column upgrades (older DBs)
  const safe = (sql: string) => {
    try { db.exec(sql); } catch {}
  };

  safe(`ALTER TABLE monitors ADD COLUMN confirmed_status TEXT DEFAULT 'UP'`);
  safe(`ALTER TABLE monitors ADD COLUMN consecutive_failures INTEGER DEFAULT 0`);
  safe(`ALTER TABLE monitors ADD COLUMN consecutive_successes INTEGER DEFAULT 0`);

  // TLS certificate expiry tracking
  safe(`ALTER TABLE monitors ADD COLUMN tls_expiry_at DATETIME`);
  safe(`ALTER TABLE monitors ADD COLUMN tls_alerted_days TEXT DEFAULT ''`);

  // Probe results — columns used by worker but missing from original CREATE
  safe(`ALTER TABLE probe_results ADD COLUMN root_cause TEXT`);
  safe(`ALTER TABLE probe_results ADD COLUMN http_status_code INTEGER`);

  // Incidents — root_cause column used by incident.service
  safe(`ALTER TABLE incidents ADD COLUMN root_cause TEXT`);

  // Maintenance flag on monitors
  safe(`ALTER TABLE monitors ADD COLUMN in_maintenance INTEGER DEFAULT 0`);

  // ---------------------------------------------------------------
  // Indexes
  //
  // Every query below ran as a full table scan before this. probe_results in
  // particular grows by ~2,880 rows per monitor per day at a 30s interval, so
  // the chart endpoint got linearly slower for the life of the deployment.
  // ---------------------------------------------------------------
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_monitors_user
      ON monitors(user_id);

    CREATE INDEX IF NOT EXISTS idx_probe_results_monitor_created
      ON probe_results(monitor_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_incidents_monitor_started
      ON incidents(monitor_id, started_at DESC);

    CREATE INDEX IF NOT EXISTS idx_incidents_open
      ON incidents(monitor_id) WHERE resolved_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_maintenance_monitor
      ON maintenance_windows(monitor_id);

    CREATE INDEX IF NOT EXISTS idx_sessions_user
      ON sessions(user_id);

    CREATE INDEX IF NOT EXISTS idx_otp_codes_user
      ON otp_codes(user_id);
  `);

  // Legacy plaintext login codes. Any of these still sitting in the table is a
  // usable credential, so clear them out on first boot after the upgrade.
  const removed = db
    .prepare(`DELETE FROM sessions WHERE token LIKE 'OTP-%'`)
    .run();

  if (removed.changes > 0) {
    console.log(`Cleared ${removed.changes} legacy plaintext OTP record(s)`);
  }

  console.log("Database migrations complete");
}
