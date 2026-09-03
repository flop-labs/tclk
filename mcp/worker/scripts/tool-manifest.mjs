// SPDX-License-Identifier: Apache-2.0
//
// Read an `McpServer`'s public surface — server info, instructions and the full tool
// catalogue with its JSON Schemas — by talking to it over the MCP SDK's in-memory
// transport, exactly as a client would.
//
// This exists so the Worker never restates the catalogue. `generate.mjs` runs it against
// the built stdio server and writes `src/tool-manifest.generated.ts`;
// `tests/manifest.test.ts` runs it against the *source* server and asserts the checked-in
// file still matches. One source, one gate: a drift shows up as a failing test rather
// than as two deployments that quietly disagree about what a tool takes.
//
// Plain `.mjs` on purpose: it is imported both by a Node build script (against
// `mcp/dist`) and by a vitest test (against `mcp/src`), and only the caller's import of
// `createServer` differs between the two.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

export const PROTOCOL_VERSIONS = {
  latest: LATEST_PROTOCOL_VERSION,
  supported: [...SUPPORTED_PROTOCOL_VERSIONS],
};

/**
 * @param {{ connect: Function, close: Function }} server an `McpServer` from `createServer()`
 * @returns {Promise<{
 *   serverInfo: { name: string, version: string },
 *   instructions: string,
 *   tools: { name: string, description?: string, inputSchema: unknown, annotations?: unknown }[],
 * }>}
 */
export async function readServerSurface(server) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tclk-mcp-manifest", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const { tools } = await client.listTools();
    return {
      serverInfo: client.getServerVersion(),
      instructions: client.getInstructions() ?? "",
      // Sorted by name so the generated file has one canonical ordering and a
      // registration reshuffle in `mcp/src/server.ts` is not a spurious diff.
      tools: [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    };
  } finally {
    await client.close();
    await server.close();
  }
}
