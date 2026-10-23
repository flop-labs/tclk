// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const schema = JSON.parse(readFileSync(
  new URL("../schema/tclk1-frames.schema.json", import.meta.url),
  "utf8",
));

function annotationKeywords(document: unknown): Set<string> {
  const keywords = new Set<string>();
  JSON.stringify(document, (key, value) => {
    if (key.startsWith("x-tclk-")) keywords.add(key);
    return value;
  });
  return keywords;
}

describe("frame schema under strict Ajv", () => {
  it("is rejected by a default Ajv2020 without the x-tclk-* keywords", () => {
    expect(() => new Ajv2020().compile(schema)).toThrow(/unknown keyword: "x-tclk-/);
  });

  it("compiles with a default Ajv2020 once every x-tclk-* keyword is registered", () => {
    const keywords = annotationKeywords(schema);
    expect(keywords.size).toBeGreaterThan(0);

    const ajv = new Ajv2020();
    for (const keyword of keywords) ajv.addKeyword({ keyword });
    expect(() => ajv.compile(schema)).not.toThrow();
  });
});
