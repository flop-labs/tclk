// SPDX-License-Identifier: Apache-2.0
//
// B3V4 fast-path helper — local one-shot authorization store.
//
// Consumes authorization IDs atomically using file creation with O_CREAT | O_EXCL.
// This prevents replay of the same authorization across invocations.
// Crash-safe: consumed authorizations remain consumed.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_STATE_DIR = join(
  process.env.HOME ?? "/tmp",
  ".local",
  "state",
  "tclk-b3v4",
  "consumed",
);

export interface AuthorizationStore {
  /**
   * Atomically consume an authorization ID.
   * Returns true if successfully consumed (first use).
   * Returns false if already consumed.
   *
   * Atomicity guarantee: exactly one concurrent caller gets true.
   */
  consume(authorizationId: string): Promise<boolean>;

  /**
   * Check if an authorization ID has been consumed (read-only).
   */
  isConsumed(authorizationId: string): Promise<boolean>;
}

/**
 * Create a file-backed authorization store.
 *
 * Each consumed authorization is stored as a file:
 *   <stateDir>/<authorizationId>
 *
 * The file content is a JSON record with metadata for reconciliation.
 */
export async function createAuthorizationStore(
  stateDir: string = DEFAULT_STATE_DIR,
): Promise<AuthorizationStore> {
  await mkdir(stateDir, { recursive: true });

  return {
    async consume(authorizationId: string): Promise<boolean> {
      const filePath = join(stateDir, sanitizeFilename(authorizationId));

      if (existsSync(filePath)) {
        return false; // Already consumed
      }

      // Atomic creation: O_CREAT | O_EXCL semantics via writeFile with exclusive flag
      // Node.js writeFile with flag 'wx' is equivalent to O_CREAT | O_EXCL
      try {
        const record = JSON.stringify({
          authorizationId,
          consumedAtMs: Date.now(),
          consumedBy: process.pid,
        });
        await writeFile(filePath, record, { flag: "wx", encoding: "utf-8" });
        return true; // Successfully consumed
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return false; // Race: another process consumed it first
        }
        throw error;
      }
    },

    async isConsumed(authorizationId: string): Promise<boolean> {
      const filePath = join(stateDir, sanitizeFilename(authorizationId));
      return existsSync(filePath);
    },
  };
}

/**
 * Sanitize an authorization ID for use as a filename.
 * Only allows alphanumeric, hyphens, and underscores.
 */
function sanitizeFilename(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}
