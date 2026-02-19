import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const isTest = process.env.NODE_ENV === "test";
const isDocker = process.env.DOCKER === "true";

// default dev database
let dbPath = path.join(process.cwd(), "routerx.db");

// test database (isolated)
if (isTest) {
  dbPath = path.join(process.cwd(), ".test-db", "routerx.test.db");
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

console.log("SQLite connected at:", dbPath);
