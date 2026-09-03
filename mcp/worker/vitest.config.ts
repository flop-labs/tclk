import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The Worker's suite needs its own config because the repo root's is scoped to
// `tests/**` — deliberately, so the default include does not sweep `mcp/tests` and run
// that suite twice — and `mcp/` inherits it for want of one of its own. Rooting this
// config at `mcp/worker` picks up `worker/tests` and nothing else, and `mcp`'s `test`
// script runs both suites in turn, so `pnpm -r --include-workspace-root test` covers the
// Worker without any change to how the other two suites are found.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
