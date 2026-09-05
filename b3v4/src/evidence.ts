// SPDX-License-Identifier: Apache-2.0
//
// B3V4 fast-path helper — evidence collection and timing.
//
// Writes machine-readable evidence files to a local directory.
// No private keys, passphrases, or secrets ever enter evidence.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { EvidenceCollector, TimingMeasurements } from "./types.js";

export async function createEvidenceCollector(
  baseDir: string,
  timestamp?: string,
): Promise<EvidenceCollector> {
  const ts = timestamp ?? new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(baseDir, `b3v4-${ts}`);
  await mkdir(dir, { recursive: true });

  const files = new Map<string, string | object>();

  return {
    dir() {
      return dir;
    },

    add(filename, data) {
      files.set(filename, typeof data === "string" ? data : JSON.parse(JSON.stringify(data)));
    },

    addText(filename, data) {
      files.set(filename, data);
    },

    async flush() {
      for (const [filename, data] of files) {
        const filepath = join(dir, filename);
        const content = typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n";
        await writeFile(filepath, content, "utf-8");
      }
    },
  };
}
