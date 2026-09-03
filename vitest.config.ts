import { defineConfig } from "vitest/config";

// The library is the root package and `mcp/` is a workspace child with its own
// suite, so scope this config to the library's own tests — the default include
// would sweep `mcp/tests` as well and run them twice.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
