import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the TypeScript sources. Without this, a `dist` left over from a
    // build gets collected as a second, broken copy of the same suite.
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
  },
});
