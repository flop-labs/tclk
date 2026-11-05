// SPDX-License-Identifier: Apache-2.0
// The schema owns the frame field sets and rail registry. This check prevents either the
// generated decoder contract or the normative SPEC table from drifting away unnoticed.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
 * Evaluate one schema leaf against a value, following at most one `$ref`. Every constraint
 * checked below is a string or integer leaf, so `minLength`/`pattern` and `minimum`/`maximum`
 * are the whole surface this needs; it is deliberately not a general JSON Schema validator.
 */
function schemaAdmits(definition: string, field: string, value: string | number): boolean {
  const property = schema.$defs[definition].properties[field];
  const leaf = property.$ref ? schema.$defs[property.$ref.split("/").at(-1)] : property;
  if (leaf.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) return false;
    if (leaf.minimum !== undefined && value < leaf.minimum) return false;
    return leaf.maximum === undefined || value <= leaf.maximum;
  }
  if (leaf.type !== "string" || typeof value !== "string") {
    throw new Error(`${definition}.${field} is not a string or integer leaf`);
  }
  if (leaf.minLength !== undefined && value.length < leaf.minLength) return false;
  return leaf.pattern === undefined || new RegExp(leaf.pattern).test(value);
}

const OFFER_FIELDS = {
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
} as const;

function offerWithJob(job: JobRef) {
  return () => makeOffer({ ...OFFER_FIELDS, job });
}

function offerWithMs(field: "claimByMs" | "refundAfterMs" | "expiresMs", value: number) {
  return () => makeOffer({ ...OFFER_FIELDS, [field]: value });
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

  it("admits no unix-ms field the decoder rejects", () => {
    // 2^53 is the first value above the range `requireMs` accepts (safe integers only);
    // `minimum: 1` already refused 0, but nothing capped the top until now.
    for (const field of ["claimByMs", "refundAfterMs", "expiresMs"] as const) {
      for (const value of [0, Number.MAX_SAFE_INTEGER + 1, 1e16]) {
        expect(schemaAdmits("offer", field, value), `schema admits offer.${field} ${value}`).toBe(false);
        expect(offerWithMs(field, value)).toThrow(new RegExp(`${field} must be a positive unix-ms integer`));
      }
    }
    expect(schemaAdmits("offer", "expiresMs", Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(offerWithMs("expiresMs", Number.MAX_SAFE_INTEGER)).not.toThrow();
  });

  it("requires paymentKey on a point-lock offer, as SPEC §3.1 and the decoder do", () => {
    // A conditional rather than a leaf, and no JSON Schema validator ships here, so the
    // keyword pair is asserted structurally the way the `uniqueItems` case above is.
    expect(schema.$defs.offer.if?.properties?.lock?.const).toBe("point");
    expect(schema.$defs.offer.then?.required).toContain("paymentKey");
    expect(() => makeOffer({ ...OFFER_FIELDS, lock: "point" })).toThrow(/point locks require paymentKey/);
  });
});
