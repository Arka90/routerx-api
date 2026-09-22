import { defineConfig } from "vitest/config";

/**
 * Unset TEST_DATABASE_URL and the suite runs against an in-process Postgres
 * (PGlite), one instance per worker, fully parallel and with nothing to
 * install. Set it and the identical suite runs against a real server — which
 * is what CI does, so the production `pg` driver is exercised too.
 */
const usingRealPostgres = Boolean(process.env.TEST_DATABASE_URL);

export default defineConfig({
  test: {
    // Only the TypeScript sources. Without this, a `dist` left over from a
    // build gets collected as a second, broken copy of the same suite.
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "dist"],

    // One shared database means one file's TRUNCATE could land in the middle
    // of another file's test, so run serially in that mode.
    ...(usingRealPostgres
      ? {
          fileParallelism: false,
          pool: "forks" as const,
          poolOptions: { forks: { singleFork: true } },
        }
      : {}),
  },
});
