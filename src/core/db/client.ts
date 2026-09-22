import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const isTest = process.env.NODE_ENV === "test";
const isDocker = process.env.DOCKER === "true";

// default dev database
let dbPath = path.join(process.cwd(), "routerx.db");

// test database (isolated). Vitest runs files in parallel workers, so each
// gets its own file — otherwise one file's fixtures are visible to another.
if (isTest) {
  const worker = process.env.VITEST_WORKER_ID ?? "0";
  dbPath = path.join(process.cwd(), ".test-db", `routerx.test.${worker}.db`);
}

// docker production database (volume)
if (isDocker) {
  dbPath = "/app/data/routerx.db";
}

// ensure directory exists
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

export const db = new Database(dbPath);

/**
 * The api and both workers open this same file off a shared Docker volume.
 * Under the default rollback journal every writer takes an exclusive lock on
 * the whole database and concurrent writes fail immediately with SQLITE_BUSY.
 *
 * WAL lets readers run while a writer holds the file, and busy_timeout makes
 * a blocked writer wait instead of throwing. Both are required for the
 * current multi-process layout to be safe.
 */
// busy_timeout goes first: switching the journal mode needs a brief
// exclusive lock, and the api and both workers race to do it on startup. Set
// the other way round, whichever process loses the race throws
// SQLITE_BUSY immediately instead of waiting its turn.
db.pragma("busy_timeout = 5000");

try {
  db.pragma("journal_mode = WAL");
} catch (error) {
  // WAL is a persistent property of the file, so losing this race is
  // harmless as long as somebody won it. Worth a line in the log, not a crash.
  console.warn("Could not set journal_mode=WAL:", error);
}

// NORMAL is the recommended durability level under WAL: a crash can lose the
// last transaction, but the database itself cannot be corrupted.
db.pragma("synchronous = NORMAL");

db.pragma("foreign_keys = ON");

console.log(
  "SQLite connected at:",
  dbPath,
  `(journal_mode=${db.pragma("journal_mode", { simple: true })})`
);
