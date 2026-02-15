import Database from "better-sqlite3";
import path from "path";

// database file location
const dbPath = path.join(process.cwd(), "routerx.db");

export const db = new Database(dbPath);

// important: enable safety
db.pragma("journal_mode = WAL");   // prevents corruption
db.pragma("foreign_keys = ON");    // enforce relations

console.log("SQLite connected at:", dbPath);
