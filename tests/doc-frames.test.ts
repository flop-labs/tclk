/**
 * Every tclk/1 frame written out in a fenced block of README.md or a Markdown file under
 * examples/ is a real frame: `decodeFrame` accepts it, and `encodeFrame` gives back the same
 * line byte for byte. Readers copy these lines and nothing else checks them; the walkthrough
 * carried five frames that never decoded until #49. A placeholder (`"id":"0x…"`) belongs in
 * prose or inline code, not in a fenced block.
 */

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { TCLK_PREFIX, decodeFrame, encodeFrame } from "../src/index.js";

const ROOT = new URL("../", import.meta.url);

/** README.md and every Markdown file under examples/, as repository-relative paths. */
function docFiles(): string[] {
  const examples = readdirSync(new URL("examples/", ROOT), { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => `examples/${name}`);
  return ["README.md", ...examples];
}

/** The body of each fenced code block, ``` or ~~~, closed by a fence at least as long. */
function fencedBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let fence: string | null = null;
  let body: string[] = [];
  for (const line of markdown.split("\n")) {
    if (fence === null) {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (open) {
        fence = open[1];
        body = [];
      }
    } else if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \t]*$`).test(line)) {
      blocks.push(body.join("\n"));
      fence = null;
    } else {
      body.push(line);
    }
  }
  // An unclosed fence runs to the end of the document.
  if (fence !== null) blocks.push(body.join("\n"));
  return blocks;
}

/** Each `tclk1 {…}` in a block, cut at the brace that closes the object, strings respected. */
function framesIn(block: string): string[] {
  const frames: string[] = [];
  let from = 0;
  for (;;) {
    const start = block.indexOf(`${TCLK_PREFIX}{`, from);
    if (start < 0) return frames;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = block.length;
    for (let i = start + TCLK_PREFIX.length; i < block.length; i++) {
      const ch = block[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    frames.push(block.slice(start, end));
    from = end;
  }
}

/** Why a frame fails the guard, or null when it decodes and re-encodes to the same line. */
function frameProblem(line: string): string | null {
  let again: string;
  try {
    again = encodeFrame(decodeFrame(line));
  } catch (error) {
    return `does not decode and re-encode: ${(error as Error).message}`;
  }
  return again === line ? null : `does not round-trip; encodeFrame gives ${again}`;
}

const found = docFiles().flatMap((file) =>
  fencedBlocks(readFileSync(new URL(file, ROOT), "utf8")).flatMap((block) =>
    framesIn(block).map((line) => ({ file, line })),
  ),
);

describe("tclk1 frames in fenced blocks of README.md and examples/", () => {
  it("finds the walkthrough's five, so the scan cannot pass by finding nothing", () => {
    expect(found.filter(({ file }) => file === "examples/htlc-walkthrough.md")).toHaveLength(5);
  });

  it("decodes every one and re-encodes it to the same line", () => {
    const problems = found.flatMap(({ file, line }) => {
      const problem = frameProblem(line);
      return problem === null ? [] : [`${file}: ${problem}\n  ${line}`];
    });
    expect(problems).toEqual([]);
  });

  it("reports the kinds of drift it exists to catch", () => {
    const lock = encodeFrame({
      type: "lock",
      from: `did:key:z6Mk${"a".repeat(44)}`,
      contract: `0x${"ab".repeat(32)}`,
      rail: "flop-htlc",
      ref: "escrow-9182",
    });
    expect(frameProblem(lock)).toBeNull();
    const { type, ...rest } = JSON.parse(lock.slice(TCLK_PREFIX.length)) as Record<string, unknown>;
    const sample = [
      "```json",
      // An illustrative frame with elided values.
      'tclk1 {"amount":"1","from":"did:key:z6Mk…","id":"0x…",…}',
      // A frame from before #49: the DID is not base58 and is 46 characters long.
      `tclk1 {"contract":"0x${"ab".repeat(32)}","from":"did:key:z6MkPayerExampleDid1111111111111111111","rail":"flop-htlc","ref":"escrow-9182","type":"lock"}`,
      // A real frame with its keys out of canonical order: it decodes, but is not the line.
      TCLK_PREFIX + JSON.stringify({ type, ...rest }),
      // A real frame wrapped onto two lines.
      lock.replace(',"from"', ',\n"from"'),
      "```",
    ].join("\n");
    const lines = fencedBlocks(sample).flatMap(framesIn);
    expect(lines).toHaveLength(4);
    expect(lines.map((line) => frameProblem(line) !== null)).toEqual([true, true, true, true]);
  });
});
