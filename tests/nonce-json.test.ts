// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it, vi } from "vitest";
import { NONCE, ROOM, TEXT, wireRow } from "./nonce-fixture.js";

const cases: [string, string, unknown][] = [
  ["plain large integer", `{"nonce":${NONCE}}`, { nonce: NONCE }],
  ["twenty-digit nonce", '{"nonce":12345678901234567890}', { nonce: "12345678901234567890" }],
  ["escaped key", `{"no\\u006ece":${NONCE}}`, { nonce: NONCE }],
  ["escaped initial", `{"\\u006eonce":${NONCE}}`, { nonce: NONCE }],
  ["leading zero", '{"nonce":01}', SyntaxError],
  ["NBSP", '{"nonce":\u00a01}', SyntaxError],
  ["exponent", '{"nonce":1e3}', { nonce: "1e3" }],
  ["fraction", '{"nonce":1.0}', { nonce: "1.0" }],
  ["negative zero", '{"nonce":-0}', { nonce: "-0" }],
  ["duplicate key", `{"nonce":1,"nonce":${NONCE}}`, { nonce: NONCE }],
  ["string nonce", `{"nonce":"${NONCE}"}`, { nonce: NONCE }],
  ["JSON-looking text", JSON.stringify({ nonce: NONCE, text: TEXT }), { nonce: NONCE, text: TEXT }],
  ["nested rows", `{"messages":[{"no\\u006ece":${NONCE}},{"nonce":1}]}`,
    { messages: [{ nonce: NONCE }, { nonce: "1" }] }],
  ["other number", `{"other":${NONCE},"nonce":1}`, { other: Number(NONCE), nonce: "1" }],
  ["truncated JSON", `{"nonce":${NONCE}`, SyntaxError],
];

describe.each([false, true])("nonce JSON, forced fallback=%s", (fallback) => {
  let lib: typeof import("../src/transcript.js");
  beforeAll(async () => {
    vi.resetModules();
    const original = JSON.parse;
    const spy = fallback ? vi.spyOn(JSON, "parse").mockImplementation((text, reviver) =>
      original(text, reviver && function (key, value) {
        return reviver.call(this, key, value);
      })) : undefined;
    try {
      // Feature detection happens at import; restore the global before each assertion.
      lib = await import("../src/transcript.js");
    } finally {
      spy?.mockRestore();
    }
  });

  it.each(cases)("%s", (_name, raw, expected) => {
    if (expected === SyntaxError) expect(() => lib.parseRecordJson(raw)).toThrow(SyntaxError);
    else expect(lib.parseRecordJson(raw)).toEqual(expected);
  });

  it.each(["1e3", "1.0", "-0", "-1", "1E+3"])("does not legalize nonce %s", (token) => {
    const raw = wireRow("nonce", token);
    expect(lib.parseRecordJson(raw)).toMatchObject({ nonce: token });
    const record = lib.transcriptRecord(ROOM, lib.parseRecordJson(raw));
    expect(lib.verifyTranscriptRecord(record)).toEqual({
      ok: false, reason: "record nonce is not canonical decimal",
    });
  });

  it.each(["nonce", "no\\u006ece", "\\u006eonce"])("verifies exact signed bytes with %s", (key) => {
    const [record] = lib.parseTranscriptExport(ROOM, wireRow(key) + "\n");
    expect(record.nonce).toBe(NONCE);
    expect(record.line).toBe(TEXT);
    expect(lib.verifyTranscriptRecord(record).ok).toBe(true);
    expect(lib.verifyTranscriptRecord({ ...record, line: TEXT + "x" }).ok).toBe(false);
    expect(lib.verifyTranscriptRecord({ ...record, nonce: String(BigInt(NONCE) + 1n) }).ok).toBe(false);
    expect(lib.verifyTranscriptRecord({ ...record, room: "other-room" }).ok).toBe(false);
  });

  it("retains last-key-wins behavior and leaves literal escaped-backslash keys alone", () => {
    expect(lib.parseRecordJson('{"nonce":1,"no\\u006ece":"002"}')).toEqual({ nonce: "002" });
    expect(lib.parseRecordJson('{"nonce":1,"nonce":null}')).toEqual({ nonce: null });
    expect(lib.parseRecordJson('{"no\\\\u006ece":1,"nonce":2}')).toEqual({
      "no\\u006ece": 1, nonce: "2",
    });
  });
});
