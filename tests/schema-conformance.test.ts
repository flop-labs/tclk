// SPDX-License-Identifier: Apache-2.0
// The schema owns the frame field sets and rail registry. This check prevents either the
// generated decoder contract or the normative SPEC table from drifting away unnoticed.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { makeOffer, validateFrame, type JobRef } from "../src/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));

const schema = JSON.parse(readFileSync(
  new URL("../schema/tclk1-frames.schema.json", import.meta.url),
  "utf8",
));

const PAYER_DID = "did:key:z6Mk" + "f".repeat(44);
const CONTRACT = "0x" + "11".repeat(32);
const PRESIG_NONCE = "0x02" + "11".repeat(32);

/**
 * Evaluate one schema string leaf against a value, following at most one `$ref`. Every
 * constraint checked below is a string leaf, so `minLength` and `pattern` are the whole
 * surface this needs; it is deliberately not a general JSON Schema validator.
 */
function schemaAdmits(definition: string, field: string, value: string): boolean {
  const property = schema.$defs[definition].properties[field];
  const leaf = property.$ref ? schema.$defs[property.$ref.split("/").at(-1)] : property;
  if (leaf.type !== "string") throw new Error(`${definition}.${field} is not a string leaf`);
  if (leaf.minLength !== undefined && value.length < leaf.minLength) return false;
  return leaf.pattern === undefined || new RegExp(leaf.pattern).test(value);
}

function offerWithJob(job: JobRef) {
  return () => makeOffer({
    from: PAYER_DID,
    role: "payer",
    amount: "1000000",
    asset: "FLOP",
    lock: "hash",
    rails: ["paper"],
    claimByMs: 1_756_800_000_000,
    refundAfterMs: 1_756_886_400_000,
    expiresMs: 1_756_713_600_000,
    nonce: "9f2c81d04c9e1f7a",
    job,
  });
}

function lockWithPresigScalar(s: string) {
  return { type: "lock", from: PAYER_DID, contract: CONTRACT, rail: "paper", ref: "escrow-1", presig: { nonce: PRESIG_NONCE, s } };
}

describe("protocol schema", () => {
  it("has current generated decoder fields and SPEC documentation", () => {
    expect(() => execFileSync(
      process.execPath,
      ["scripts/generate-frame-fields.mjs", "--check"],
      { cwd: root, stdio: "pipe" },
    )).not.toThrow();
  });

  // That check compares both artefacts byte for byte, and nothing pinned the checkout's line
  // endings, so a clone made with `core.autocrlf=true` reported the protocol as stale when
  // only its line endings differed. Line endings are the checkout's business; what the schema
  // says is not, and folding them away must not cost the check its teeth.
  it("reports drift by generated content, not by checkout line endings", () => {
    const scratch = mkdtempSync(join(tmpdir(), "tclk-eol-"));
    try {
      for (const dir of ["schema", "scripts", "src"]) mkdirSync(join(scratch, dir));
      const schemaCopy = join(scratch, "schema", "tclk1-frames.schema.json");
      const script = join(scratch, "scripts", "generate-frame-fields.mjs");
      copyFileSync(join(root, "scripts", "generate-frame-fields.mjs"), script);
      copyFileSync(join(root, "schema", "tclk1-frames.schema.json"), schemaCopy);
      const generatedCopy = join(scratch, "src", "frame-fields.generated.ts");
      for (const file of [join("src", "frame-fields.generated.ts"), "SPEC.md"]) {
        writeFileSync(join(scratch, file), readFileSync(join(root, file), "utf8").replace(/\r?\n/g, "\r\n"));
      }
      const check = () => execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" });

      expect(readFileSync(generatedCopy, "utf8")).toContain("\r\n");
      expect(check).not.toThrow();

      const drifted = JSON.parse(readFileSync(schemaCopy, "utf8"));
      drifted.$defs.rail["x-tclk-canonicalIds"].push("unregenerated-rail");
      writeFileSync(schemaCopy, JSON.stringify(drifted, null, 2));
      expect(check).toThrow();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("keeps historical duplicate rail arrays decodable under tclk1", () => {
    expect(schema.$defs.offer.properties.rails.uniqueItems).toBeUndefined();
  });

  // SPEC §3 calls this schema "the same artifact the decoder uses" and the package ships
  // it, so an independent implementation validates against the schema rather than against
  // `src/`. A constraint the decoder enforces but the schema omits leaves that
  // implementation emitting frames the reference rejects, which is why both halves are
  // asserted on the same values here.

  it("admits no pre-signature scalar the decoder rejects", () => {
    for (const s of ["0x1", "0x111", `0x${"a".repeat(63)}`]) {
      expect(schemaAdmits("presig", "s", s), `schema admits presig.s ${s}`).toBe(false);
      expect(() => validateFrame(lockWithPresigScalar(s))).toThrow(/presig\.s is malformed/);
    }
    for (const s of ["0x11", `0x${"a".repeat(64)}`]) {
      expect(schemaAdmits("presig", "s", s), `schema rejects presig.s ${s}`).toBe(true);
      expect(() => validateFrame(lockWithPresigScalar(s))).not.toThrow();
    }
  });

  it("admits no job reference the decoder rejects", () => {
    const rejected: ReadonlyArray<[keyof JobRef, string, JobRef]> = [
      ["proto", "A2A", { proto: "A2A", id: "task-3f" }],
      ["proto", "", { proto: "", id: "task-3f" }],
      ["id", "", { proto: "a2a", id: "" }],
      ["context", "", { proto: "a2a", id: "task-3f", context: "" }],
    ];
    for (const [field, value, job] of rejected) {
      expect(schemaAdmits("job", field, value), `schema admits job.${field} ${JSON.stringify(value)}`).toBe(false);
      expect(offerWithJob(job)).toThrow(new RegExp(`job\\.${field}`));
    }
    expect(offerWithJob({ proto: "a2a", id: "task-3f", context: "ctx-1" })).not.toThrow();
  });
});
