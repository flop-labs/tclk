// SPDX-License-Identifier: Apache-2.0
//
// Execute the real example with a mocked venue; no network requests or room writes.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const example = fileURLToPath(new URL("../examples/live-deal.mjs", import.meta.url));
const preload = fileURLToPath(new URL("./fixtures/live-deal-redirect-fetch.mjs", import.meta.url));

describe("live-deal signed POST transport", () => {
  it("refuses a redirect instead of reporting an unpersisted offer as posted", () => {
    const run = spawnSync(process.execPath, ["--import", preload, example], {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, TECHNOCORE_URL: "http://localhost:8080" },
    });

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("The venue refused. post to tclk-offers: 302");
    expect(run.stdout).not.toMatch(/offer\s+posted to/);
  });
});
