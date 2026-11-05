import { describe, expect, it } from "vitest";
import {
  capabilityToken,
  dealRoom,
  parseCapabilityToken,
  parseStateNoteValue,
  stateNote,
  stateNoteValue,
} from "../src/technocore.js";

describe("tclk: technocore venue binding & validation", () => {
  const VALID_CONTRACT = "0x" + "a".repeat(64);
  const INVALID_CONTRACT = "0x1234badcontract";

  describe("dealRoom & stateNote contract constraints", () => {
    it("generates a valid signed mailbox deal room name", () => {
      const room = dealRoom(VALID_CONTRACT);
      expect(room).toBe("mb-p-tclk-aaaaaaaaaaaaaaaa");
      expect(room.length).toBeLessThanOrEqual(26);
    });

    it("throws on a malformed contract id", () => {
      expect(() => dealRoom(INVALID_CONTRACT)).toThrow(/malformed contract id/);
      expect(() => stateNote(INVALID_CONTRACT)).toThrow(/malformed contract id/);
    });

    it("shards stateNote into the correct namespace and key", () => {
      const note = stateNote(VALID_CONTRACT);
      expect(note.ns).toBe("tclk-aa");
      expect(note.key).toBe("aaaaaaaaaaaaaa");
    });
  });

  describe("capabilityToken parsing (fail-closed)", () => {
    it("generates and parses a valid capability token", () => {
      const token = capabilityToken(["flop-htlc", "x402"]);
      expect(token).toBe("tclk1:flop-htlc,x402");

      const parsed = parseCapabilityToken(`routing-hint ${token} extra-note`);
      expect(parsed).toEqual(["flop-htlc", "x402"]);
    });

    it("throws when generating a capability token with empty rails", () => {
      expect(() => capabilityToken([])).toThrow(/at least one rail/);
    });
  });

  describe("stateNoteValue parsing & serialization", () => {
    it("serializes and parses a valid status and railRef", () => {
      const serialized = stateNoteValue("locked", "rail-tx-123");
      expect(serialized).toBe("locked rail-tx-123");

      const parsed = parseStateNoteValue(serialized);
      expect(parsed).toEqual({ status: "locked", railRef: "rail-tx-123" });
    });

    it("throws when serializing a railRef with spaces", () => {
      expect(() => stateNoteValue("accepted", "invalid ref with spaces")).toThrow(
        /printable ASCII without spaces/
      );
    });
  });
});
