// SPDX-License-Identifier: Apache-2.0
//
// Types for `tool-manifest.mjs`, which stays plain JavaScript because the Node build
// script and the vitest test import it against different builds of the same server.

export declare const PROTOCOL_VERSIONS: { latest: string; supported: string[] };

export interface ServerSurface {
  serverInfo: { name: string; version: string };
  instructions: string;
  tools: {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
    [key: string]: unknown;
  }[];
}

export declare function readServerSurface(server: {
  connect(transport: never): Promise<void>;
  close(): Promise<void>;
}): Promise<ServerSurface>;
