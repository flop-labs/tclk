#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// `tclk-mcp` over stdio. stdout is the MCP transport — nothing else may write to it, so
// the one diagnostic here goes to stderr.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`tclk-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
