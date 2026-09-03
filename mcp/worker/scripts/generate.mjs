// SPDX-License-Identifier: Apache-2.0
//
// Write `src/tool-manifest.generated.ts` from the stdio server's own registrations.
//
//     pnpm --filter @flop-labs/tclk-mcp run gen:worker-manifest
//
// Runs against `mcp/dist`, so `pnpm -r --include-workspace-root build` has to have run
// first. The result is committed: `wrangler deploy` must work from a fresh checkout
// without a code-generation step in front of it, and `tests/manifest.test.ts` is what
// keeps the committed copy honest.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "../../dist/server.js";
import { PROTOCOL_VERSIONS, readServerSurface } from "./tool-manifest.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "src", "tool-manifest.generated.ts");

// An empty env, not the process environment: the manifest must describe the tool
// surface, and nothing about it may depend on which keys this machine happens to hold.
const surface = await readServerSurface(createServer({ env: {} }));

const banner = `// SPDX-License-Identifier: Apache-2.0
//
// GENERATED FILE — do not edit by hand.
//
// Written by \`scripts/generate.mjs\` from the tool registrations in \`mcp/src/server.ts\`,
// read back over the MCP SDK's in-memory transport exactly as a client would see them.
// The Worker serves this verbatim so the hosted deployment and the stdio build cannot
// advertise different tools, different schemas, or a different handshake.
//
// Regenerate with:
//     pnpm -r --include-workspace-root build
//     pnpm --filter @flop-labs/tclk-mcp run gen:worker-manifest
//
// \`tests/manifest.test.ts\` fails if this file and \`mcp/src/server.ts\` have drifted.

export interface ManifestTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  /**
   * Whatever else the SDK's tool descriptor carries — \`execution\`, and anything a
   * future version adds. Passed through to clients verbatim rather than filtered, so a
   * new field reaches them without this file having to learn about it first.
   */
  [key: string]: unknown;
}

/** Protocol versions this build of the MCP SDK speaks, newest first. */
export const PROTOCOL_VERSIONS: readonly string[] = ${JSON.stringify(PROTOCOL_VERSIONS.supported, null, 2)};

/** The version offered when a client asks for one this server does not know. */
export const LATEST_PROTOCOL_VERSION = ${JSON.stringify(PROTOCOL_VERSIONS.latest)};

export const SERVER_INFO = ${JSON.stringify(surface.serverInfo, null, 2)} as const;

export const INSTRUCTIONS = ${JSON.stringify(surface.instructions)};

export const TOOLS: readonly ManifestTool[] = ${JSON.stringify(surface.tools, null, 2)};
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, banner);
process.stdout.write(`wrote ${out} (${surface.tools.length} tools)\n`);
