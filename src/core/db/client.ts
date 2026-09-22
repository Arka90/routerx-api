import { Pool, types } from "pg";
import { config } from "../config";

/**
 * node-postgres hands back BIGINT (oid 20) as a string, because a 64-bit
 * integer does not fit in a JS number. Every id in this schema is a bigserial
 * that will not come close to 2^53, and ids silently arriving as strings
 * breaks every comparison against a parsed route param. Parse them once here
 * rather than coercing at hundreds of call sites.
 */
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

export interface QueryResultLike<T> {
  rows: T[];
  rowCount: number;
}

/** The surface a transaction body is handed. */
export interface TxClient {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResultLike<T>>;
}

interface Driver {
  query<T>(text: string, params: unknown[]): Promise<QueryResultLike<T>>;
  transaction<T>(fn: (client: TxClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------
// Production driver: a real Postgres connection pool.
// ---------------------------------------------------------------

function createPoolDriver(): Driver {
  const pool = new Pool({
    connectionString: config.database.url,
    max: config.database.poolSize,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: config.database.ssl ? { rejectUnauthorized: false } : undefined,
  });

  // An idle client erroring out (a database restart, a dropped connection)
  // emits on the pool; with no listener Node treats it as unhandled.
  pool.on("error", (error) => {
    console.error("Postgres pool error:", error.message);
  });

  return {
    async query<T>(text: string, params: unknown[]) {
      const result = await pool.query(text, params as never[]);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    },

    async transaction<T>(fn: (client: TxClient) => Promise<T>) {
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        const result = await fn({
          query: async (text, params = []) => {
            const r = await client.query(text, params as never[]);
            return { rows: r.rows as never[], rowCount: r.rowCount ?? 0 };
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {
          // Connection already broken; the original error is what matters.
        });
        throw error;
      } finally {
        client.release();
      }
    },

    close: () => pool.end(),
  };
}

// ---------------------------------------------------------------
// Test driver: Postgres compiled to WebAssembly, in this process.
//
// Same engine and therefore the same SQL semantics — CTEs, partial unique
// indexes, ON CONFLICT ... WHERE, arrays, jsonb all behave as they do in
// production — with no container to install or wait for. Set
// TEST_DATABASE_URL to run the identical suite against a real server.
// ---------------------------------------------------------------

function createPgliteDriver(): Driver {
  // Required lazily so production never loads the WASM build.
  const { PGlite } = require("@electric-sql/pglite");
  const { citext } = require("@electric-sql/pglite/contrib/citext");

  const ready = PGlite.create({ extensions: { citext } });

  /**
   * PGlite's query() speaks the extended protocol, which carries exactly one
   * command per message — the same restriction a parameterised query has on a
   * real server. Multi-statement SQL (the migrations) has to go through
   * exec(), which uses the simple protocol. node-postgres picks between the
   * two on your behalf; here the choice is explicit.
   */
  const run = async <T>(
    handle: { query: Function; exec: Function },
    text: string,
    params: unknown[]
  ): Promise<QueryResultLike<T>> => {
    if (params.length === 0) {
      const results = (await handle.exec(text)) as Array<{
        rows: unknown[];
        affectedRows?: number;
      }>;

      const last = results[results.length - 1];

      return {
        rows: (last?.rows ?? []) as T[],
        rowCount: last?.affectedRows ?? last?.rows.length ?? 0,
      };
    }

    const result = (await handle.query(text, params)) as {
      rows: unknown[];
      affectedRows?: number;
    };

    return {
      rows: result.rows as T[],
      rowCount: result.affectedRows ?? result.rows.length,
    };
  };

  return {
    async query<T>(text: string, params: unknown[]) {
      return run<T>(await ready, text, params);
    },

    async transaction<T>(fn: (client: TxClient) => Promise<T>) {
      const db = await ready;

      return db.transaction(async (tx: { query: Function; exec: Function }) =>
        fn({
          query: (text: string, params: unknown[] = []) => run(tx, text, params),
        })
      );
    },

    async close() {
      const db = await ready;
      await db.close();
    },
  };
}

const useInProcessDatabase = config.isTest && !process.env.TEST_DATABASE_URL;

const driver: Driver = useInProcessDatabase ? createPgliteDriver() : createPoolDriver();

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await driver.query<T>(text, params);
  return result.rows;
}

export async function queryOne<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T | undefined> {
  const rows = await query<T>(text, params);
  return rows[0];
}

/** Returns the number of rows affected. */
export async function execute(text: string, params: unknown[] = []): Promise<number> {
  const result = await driver.query(text, params);
  return result.rowCount;
}

/**
 * Run `fn` inside a transaction. Every query inside must go through the
 * client handed to `fn` — calling the module-level helpers would check out a
 * different connection and silently run outside the transaction.
 */
export async function withTransaction<T>(
  fn: (client: TxClient) => Promise<T>
): Promise<T> {
  return driver.transaction(fn);
}

export async function closePool(): Promise<void> {
  await driver.close();
}

/** Raw access for the migration runner, which needs a pinned connection. */
export const rawDriver = driver;
