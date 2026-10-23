// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { probeRoomCreation } from "../src/technocore.js";

describe("probeRoomCreation", () => {
  test("reports available when room creation succeeds", async () => {
    const mockFetch = async () => new Response("OK", { status: 200 });
    const result = await probeRoomCreation("https://example.test", mockFetch);
    expect(result).toEqual({ available: true });
  });

  test("reports unavailable on 400 room limit reached", async () => {
    const mockFetch = async () =>
      new Response("400 room limit reached (81920 is the cap, and this would be a new one).", {
        status: 400,
      });
    const result = await probeRoomCreation("https://example.test", mockFetch);
    expect(result).toEqual({
      available: false,
      status: 400,
      reason: "400 room limit reached (81920 is the cap, and this would be a new one).",
    });
  });

  test("reports unavailable on other 400 errors", async () => {
    const mockFetch = async () => new Response("400 bad request\ndetails", { status: 400 });
    const result = await probeRoomCreation("https://example.test", mockFetch);
    expect(result).toEqual({
      available: false,
      status: 400,
      reason: "400 bad request",
    });
  });

  test("reports unavailable on other HTTP errors", async () => {
    const mockFetch = async () => new Response("500 internal error", { status: 500 });
    const result = await probeRoomCreation("https://example.test", mockFetch);
    expect(result).toEqual({
      available: false,
      status: 500,
      reason: "500 internal error",
    });
  });

  test("reports unavailable on network error", async () => {
    const mockFetch = async () => {
      throw new Error("network unreachable");
    };
    const result = await probeRoomCreation("https://example.test", mockFetch);
    expect(result).toEqual({
      available: false,
      status: 0,
      reason: "network unreachable",
    });
  });

  test("extracts first non-empty line from multi-line body", async () => {
    const mockFetch = async () =>
      new Response("\n\n400 room limit reached (cap 102400)\nSome other detail", { status: 400 });
    const result = await probeRoomCreation("https://example.test", mockFetch);
    expect(result).toEqual({
      available: false,
      status: 400,
      reason: "400 room limit reached (cap 102400)",
    });
  });

  test("handles empty response body", async () => {
    const mockFetch = async () => new Response("", { status: 400 });
    const result = await probeRoomCreation("https://example.test", mockFetch);
    expect(result).toEqual({
      available: false,
      status: 400,
      reason: "",
    });
  });
});
