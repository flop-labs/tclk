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
    it("should generate valid signed mailbox deal room name", () => {
      const room = dealRoom(VALID_CONTRACT);
      expect(room).toBe("mb-p-tclk-aaaaaaaaaaaaaaaa");
      expect(room.length).toBeLessThanOrEqual(26);
    });

    it("should throw error on malformed contract id", () => {
      expect(() => dealRoom(INVALID_CONTRACT)).toThrow(/malformed contract id/);
      expect(() => stateNote(INVALID_CONTRACT)).toThrow(/malformed contract id/);
    });

    it("should correctly shard stateNote namespace and key", () => {
      const note = stateNote(VALID_CONTRACT);
      expect(note.ns).toBe("tclk-aa");
      expect(note.key).toBe("aaaaaaaaaaaaaa");
    });
  });

  describe("capabilityToken parsing (fail-closed)", () => {
    it("should generate and parse valid capability token", () => {
      const token = capabilityToken(["flop-htlc", "x402"]);
      expect(token).toBe("tclk1:flop-htlc,x402");

      const parsed = parseCapabilityToken(`routing-hint ${token} extra-note`);
      expect(parsed).toEqual(["flop-htlc", "x402"]);
    });

    it("should return null on missing or malformed tokens", () => {
      expect(parseCapabilityToken("no token here")).toBeNull();
      expect(parseCapabilityToken("tclk1:")).toBeNull();
      expect(parseCapabilityToken("tclk1:invalid space rail")).toBeNull();
    });

    it("should throw error when generating capability token with empty rails", () => {
      expect(() => capabilityToken([])).toThrow(/at least one rail/);
    });
  });

  describe("stateNoteValue parsing & serialization", () => {
    it("should serialize and parse valid status and railRef", () => {
      const serialized = stateNoteValue("locked", "rail-tx-123");
      expect(serialized).toBe("locked rail-tx-123");

      const parsed = parseStateNoteValue(serialized);
      expect(parsed).toEqual({ status: "locked", railRef: "rail-tx-123" });
    });

    it("should return null on invalid status or spaces in railRef", () => {
      expect(parseStateNoteValue("invalid_status")).toBeNull();
      expect(parseStateNoteValue("proposed invalid rail ref")).toBeNull(); // extra space
    });

    it("should throw error when serializing invalid railRef", () => {
      expect(() => stateNoteValue("accepted", "invalid ref with spaces")).toThrow(
        /printable ASCII without spaces/
      );
    });
  });
});
