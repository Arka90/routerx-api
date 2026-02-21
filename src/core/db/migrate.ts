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

  console.log("Database migrations complete");
}
