// SPDX-License-Identifier: Apache-2.0
//
// Structural parity between the schema and the decoder's hand-written contract.
//
// `tests/schema-conformance.test.ts` samples values through both halves and asserts they
// agree on each one. This file asks the prior question: are the two halves describing the
// same *set* of fields at all? Value sampling cannot see a key the decoder allows and the
// schema does not, or a nested object the generator never reached.
//
// The generator owns the nine frame types (`FRAME_FIELDS`) and CI gates them with
// `--check`. It does not reach inside them: `Object.keys(definition.properties)` is one
// level deep, so the allowed-key sets for `job` and `presig` are written out by hand in
// `src/frames.ts` beside a schema that states them too. Two sources for one contract is how
// #59 and #72 happened, and a hand-written recursive key walk is what #16 is about. This
// pins the parity that has to hold before either set can be generated from the other.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { FRAME_FIELDS } from "../src/frame-fields.generated.js";
import { makeOffer, validateFrame, type JobRef } from "../src/index.js";

const schema = JSON.parse(readFileSync(
  new URL("../schema/tclk1-frames.schema.json", import.meta.url),
  "utf8",
));

const PAYER = "did:key:z6Mk" + "f".repeat(44);
const CONTRACT = "0x" + "11".repeat(32);
const PRESIG_NONCE = "0x02" + "11".repeat(32);
const PRESIG_S = "0x" + "ab".repeat(32);

/** The nested object definitions this file carries a parity case for. */
const NESTED_UNDER_TEST = ["job", "presig"] as const;

function offerWith(job: unknown) {
  return () => makeOffer({
    from: PAYER,
    role: "payer",
    amount: "1000000",
    asset: "FLOP",
    lock: "hash",
    rails: ["paper"],
    claimByMs: 1_756_800_000_000,
    refundAfterMs: 1_756_886_400_000,
    expiresMs: 1_756_713_600_000,
    nonce: "9f2c81d04c9e1f7a",
    job: job as JobRef,
  });
}

function lockWith(presig: unknown) {
  return () => validateFrame({
    type: "lock",
    from: PAYER,
    contract: CONTRACT,
    rail: "paper",
    ref: "escrow-1",
    presig,
  } as never);
}

/** Drive one nested definition through the decoder by the frame that carries it. */
const CARRIER: Record<(typeof NESTED_UNDER_TEST)[number], {
  valid: Record<string, unknown>;
  optional: Record<string, unknown>;
  build: (value: unknown) => () => unknown;
}> = {
  job: {
    valid: { proto: "a2a", id: "task-3f" },
    optional: { context: "ctx-1" },
    build: offerWith,
  },
  presig: {
    valid: { nonce: PRESIG_NONCE, s: PRESIG_S },
    optional: {},
    build: lockWith,
  },
};

describe("the schema owns the field contract, including inside a frame", () => {
  it("generates a contract for every frame type and for no nested object", () => {
    // What the generator reaches today, stated as a fact rather than assumed: exactly the
    // `oneOf` members. If a frame type is added to the schema and not to `oneOf`, or the
    // generator starts emitting nested sets, this is the line that notices.
    const frameTypes = schema.oneOf.map((entry: { $ref: string }) => entry.$ref.split("/").at(-1));
    expect(Object.keys(FRAME_FIELDS).sort()).toEqual([...frameTypes].sort());
  });

  it("leaves exactly the nested definitions this file covers to hand-written sets", () => {
    // The drift tripwire for the pipeline. A third nested object in the schema is a third
    // hand-written key set in `src/frames.ts`, and it fails here until it is covered.
    const objects = Object.entries(schema.$defs)
      .filter(([, definition]) => (definition as { type?: string }).type === "object")
      .map(([name]) => name);
    const generated = new Set(Object.keys(FRAME_FIELDS));
    expect(objects.filter((name) => !generated.has(name)).sort())
      .toEqual([...NESTED_UNDER_TEST].sort());
  });

  it.each(NESTED_UNDER_TEST)(
    "%s: the decoder allows exactly the keys the schema declares",
    (name) => {
      const definition = schema.$defs[name];
      const { valid, optional, build } = CARRIER[name];
      expect(definition.additionalProperties).toBe(false);

      // Every declared property is reachable: the base plus each optional one validates.
      expect(build(valid)).not.toThrow();
      for (const [key, value] of Object.entries(optional)) {
        expect(build({ ...valid, [key]: value }), `${name}.${key} declared but refused`).not.toThrow();
      }
      // …and the base plus the optionals is the whole declared set, so the test cannot pass
      // while silently skipping a property the schema added.
      expect(Object.keys({ ...valid, ...optional }).sort())
        .toEqual(Object.keys(definition.properties).sort());

      // A key the schema does not declare is refused, which is what `additionalProperties`
      // means on the other side of the contract.
      expect(build({ ...valid, unexpected: "x" }))
        .toThrow(new RegExp(`unknown field on ${name}: unexpected`));
    },
  );

  it.each(NESTED_UNDER_TEST)(
    "%s: the decoder requires exactly the keys the schema requires",
    (name) => {
      const definition = schema.$defs[name];
      const { valid, build } = CARRIER[name];
      expect([...definition.required].sort()).toEqual(Object.keys(valid).sort());

      for (const key of definition.required) {
        const { [key]: _dropped, ...without } = valid;
        expect(build(without), `${name}.${key} required by the schema but not the decoder`)
          .toThrow(new RegExp(`missing field on ${name}: ${key}`));
      }
    },
  );
});
