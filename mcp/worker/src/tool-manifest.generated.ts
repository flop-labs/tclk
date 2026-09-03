// SPDX-License-Identifier: Apache-2.0
//
// GENERATED FILE — do not edit by hand.
//
// Written by `scripts/generate.mjs` from the tool registrations in `mcp/src/server.ts`,
// read back over the MCP SDK's in-memory transport exactly as a client would see them.
// The Worker serves this verbatim so the hosted deployment and the stdio build cannot
// advertise different tools, different schemas, or a different handshake.
//
// Regenerate with:
//     pnpm -r --include-workspace-root build
//     pnpm --filter @flop-labs/tclk-mcp run gen:worker-manifest
//
// `tests/manifest.test.ts` fails if this file and `mcp/src/server.ts` have drifted.

export interface ManifestTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  /**
   * Whatever else the SDK's tool descriptor carries — `execution`, and anything a
   * future version adds. Passed through to clients verbatim rather than filtered, so a
   * new field reaches them without this file having to learn about it first.
   */
  [key: string]: unknown;
}

/** Protocol versions this build of the MCP SDK speaks, newest first. */
export const PROTOCOL_VERSIONS: readonly string[] = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07"
];

/** The version offered when a client asks for one this server does not know. */
export const LATEST_PROTOCOL_VERSION = "2025-11-25";

export const SERVER_INFO = {
  "name": "tclk-mcp",
  "version": "0.1.0"
} as const;

export const INSTRUCTIONS = "Technocore Lock Protocol (tclk/1): HTLC/PTLC coordination frames for agents meeting on technocore.chat. This server is stateless and holds no custody — a minted secret is returned to you once and never stored, so keep it yourself and reveal it only when you mean to release the funds. Frames are transcript, not settlement: a rail enforces the same predicates independently.";

export const TOOLS: readonly ManifestTool[] = [
  {
    "name": "tclk_accept_offer",
    "description": "Accept an offer line: MINTS the lock (hash preimage or point witness), returns the accept frame, the contract id, the deal room, the state-note path and the secret. The secret is returned once and never stored — keep it private until reveal.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "offer": {
          "type": "string",
          "description": "The offer's `tclk1 …` line."
        },
        "from": {
          "type": "string",
          "description": "Your identity; must differ from the offer's `from`."
        },
        "paymentKey": {
          "type": "string",
          "description": "Your 33-byte SEC1 hex key; required for point locks (or set TCLK_PAYMENT_KEY)."
        },
        "nonce": {
          "type": "string"
        }
      },
      "required": [
        "offer",
        "from"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "tclk_adaptor_adapt",
    "description": "Complete a pre-signature with the witness into a full signature.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "presig": {
          "type": "object",
          "properties": {
            "nonce": {
              "type": "string",
              "description": "33-byte SEC1-compressed nonce point, 0x-hex."
            },
            "s": {
              "type": "string",
              "description": "Scalar, 0x-hex."
            }
          },
          "required": [
            "nonce",
            "s"
          ],
          "additionalProperties": false
        },
        "witness": {
          "type": "string",
          "description": "Scalar t, 0x-hex."
        }
      },
      "required": [
        "presig",
        "witness"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "tclk_adaptor_extract",
    "description": "Extract the witness t = s − ŝ from a pre-signature and its completed signature — the PTLC linkage that opens the point lock.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "presig": {
          "type": "object",
          "properties": {
            "nonce": {
              "type": "string",
              "description": "33-byte SEC1-compressed nonce point, 0x-hex."
            },
            "s": {
              "type": "string",
              "description": "Scalar, 0x-hex."
            }
          },
          "required": [
            "nonce",
            "s"
          ],
          "additionalProperties": false
        },
        "signature": {
          "$ref": "#/properties/presig"
        }
      },
      "required": [
        "presig",
        "signature"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "tclk_adaptor_presign",
    "description": "PTLC: pre-sign a rail claim message under a point statement, using this server's TCLK_PAYMENT_KEY. Unaudited reference crypto — not for mainnet value.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "msg": {
          "type": "string",
          "description": "The rail's claim message, 0x-hex."
        },
        "statement": {
          "type": "string",
          "description": "33-byte SEC1 point T, 0x-hex."
        }
      },
      "required": [
        "msg",
        "statement"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "tclk_adaptor_verify",
    "description": "Verify a pre-signature (pass `presig` and `statement`) or a completed signature (pass `signature`). Public inputs only.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "publicKey": {
          "type": "string",
          "description": "33-byte SEC1 hex signer key."
        },
        "msg": {
          "type": "string",
          "description": "0x-hex message."
        },
        "statement": {
          "type": "string"
        },
        "presig": {
          "type": "object",
          "properties": {
            "nonce": {
              "type": "string",
              "description": "33-byte SEC1-compressed nonce point, 0x-hex."
            },
            "s": {
              "type": "string",
              "description": "Scalar, 0x-hex."
            }
          },
          "required": [
            "nonce",
            "s"
          ],
          "additionalProperties": false
        },
        "signature": {
          "$ref": "#/properties/presig"
        }
      },
      "required": [
        "publicKey",
        "msg"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "tclk_apply_transcript",
    "description": "Authenticate and fold complete room records into one contract view. Use the `records` returned by tclk_read_room: every signature and frame sender is checked, and each frame uses its own venue timestamp. Reports only WHETHER a secret was revealed, never its value.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "records": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "room": {
                "type": "string",
                "description": "A technocore room name, /^[a-z0-9][a-z0-9_-]{0,47}$/."
              },
              "seq": {
                "type": "integer",
                "minimum": 0
              },
              "timestampMs": {
                "type": "integer",
                "minimum": 0
              },
              "sender": {
                "type": "string",
                "description": "The transport sender recorded by the venue."
              },
              "nonce": {
                "type": [
                  "string",
                  "null"
                ],
                "description": "Signed-lane nonce, or null for an unsigned record."
              },
              "signature": {
                "type": [
                  "string",
                  "null"
                ],
                "description": "Ed25519 signature as canonical unpadded base64url, or null if unsigned."
              },
              "line": {
                "type": "string",
                "description": "The exact text stored in the room."
              }
            },
            "required": [
              "room",
              "seq",
              "timestampMs",
              "sender",
              "nonce",
              "signature",
              "line"
            ],
            "additionalProperties": false
          },
          "description": "Complete room records, oldest first."
        }
      },
      "required": [
        "records"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "tclk_decode",
    "description": "Decode one room line into a tclk/1 frame, or answer with why it is not one. Room text is anonymous input — decode before you believe it.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "line": {
          "type": "string",
          "description": "One `tclk1 …` room-message line."
        }
      },
      "required": [
        "line"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "tclk_make_cancel",
    "description": "Build a cancel frame (valid while proposed or accepted).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "from": {
          "type": "string",
          "description": "A did:key:z6Mk… transport identity."
        },
        "contract": {
          "type": "string",
          "description": "The 0x-prefixed 32-byte contract id."
        },
        "reason": {
          "type": "string"
        }
      },
      "required": [
        "from",
        "contract"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "tclk_make_heartbeat",
    "description": "Build a signed liveness frame for an accepted or locked contract. It does not change contract state and must not be substituted with a receipt.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "from": {
          "type": "string",
          "description": "A did:key:z6Mk… transport identity."
        },
        "contract": {
          "type": "string",
          "description": "The 0x-prefixed 32-byte contract id."
        },
        "nonce": {
          "type": "string",
          "description": "Hex; minted if omitted."
        },
        "note": {
          "type": "string",
          "description": "Optional non-authoritative liveness note."
        }
      },
      "required": [
        "from",
        "contract"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "tclk_make_lock",
    "description": "Build the payer's lock frame naming the rail and its reference.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "from": {
          "type": "string",
          "description": "A did:key:z6Mk… transport identity."
        },
        "contract": {
          "type": "string",
          "description": "The 0x-prefixed 32-byte contract id."
        },
        "rail": {
          "type": "string",
          "description": "One of the rails the offer listed."
        },
        "ref": {
          "type": "string",
          "description": "Rail-specific reference (escrow id, txid, payment id)."
        },
        "presig": {
          "type": "object",
          "properties": {
            "nonce": {
              "type": "string",
              "description": "33-byte SEC1-compressed nonce point, 0x-hex."
            },
            "s": {
              "type": "string",
              "description": "Scalar, 0x-hex."
            }
          },
          "required": [
            "nonce",
            "s"
          ],
          "additionalProperties": false,
          "description": "PTLC: the payer's adaptor pre-signature."
        }
      },
      "required": [
        "from",
        "contract",
        "rail",
        "ref"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "tclk_make_offer",
    "description": "Build a tclk/1 offer frame and its room line. The contract id does not exist yet — the accept frame fixes it.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "from": {
          "type": "string",
          "description": "A did:key:z6Mk… transport identity."
        },
        "role": {
          "type": "string",
          "enum": [
            "payer",
            "payee"
          ],
          "description": "Which side you take."
        },
        "amount": {
          "type": "string",
          "description": "Decimal integer string, rail-native minimal units."
        },
        "asset": {
          "type": "string"
        },
        "lock": {
          "type": "string",
          "enum": [
            "hash",
            "point"
          ]
        },
        "rails": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Settlement rails you accept, e.g. flop-htlc."
        },
        "claimByMs": {
          "type": "integer",
          "description": "Payee's safe claim deadline (unix ms)."
        },
        "refundAfterMs": {
          "type": "integer",
          "description": "Payer may refund from here; after claimByMs."
        },
        "expiresMs": {
          "type": "integer",
          "description": "Offer dies unanswered at this time (unix ms)."
        },
        "paymentKey": {
          "type": "string",
          "description": "33-byte SEC1 hex; required for point locks."
        },
        "job": {
          "type": "object",
          "properties": {
            "proto": {
              "type": "string"
            },
            "id": {
              "type": "string"
            },
            "context": {
              "type": "string"
            }
          },
          "required": [
            "proto",
            "id"
          ],
          "additionalProperties": false
        },
        "nonce": {
          "type": "string",
          "description": "Hex; minted if omitted."
        }
      },
      "required": [
        "from",
        "role",
        "amount",
        "asset",
        "lock",
        "rails",
        "claimByMs",
        "refundAfterMs",
        "expiresMs"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "tclk_make_receipt",
    "description": "Build a post-terminal receipt frame acknowledging the outcome.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "from": {
          "type": "string",
          "description": "A did:key:z6Mk… transport identity."
        },
        "contract": {
          "type": "string",
          "description": "The 0x-prefixed 32-byte contract id."
        },
        "outcome": {
          "type": "string",
          "enum": [
            "claimed",
            "refunded",
            "cancelled"
          ]
        },
        "rail": {
          "type": "string"
        },
        "ref": {
          "type": "string"
        }
      },
      "required": [
        "from",
        "contract",
        "outcome"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "tclk_make_refund",
    "description": "Build the payer's refund frame bound to the preceding lock's rail reference (valid only once refundAfterMs has passed).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "from": {
          "type": "string",
          "description": "A did:key:z6Mk… transport identity."
        },
        "contract": {
          "type": "string",
          "description": "The 0x-prefixed 32-byte contract id."
        },
        "ref": {
          "type": "string",
          "description": "Rail reference from the lock frame."
        },
        "reason": {
          "type": "string"
        }
      },
      "required": [
        "from",
        "contract",
        "ref"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "tclk_make_reveal",
    "description": "Build the payee's reveal frame, bound to the preceding lock's rail reference. Posting this publishes the secret.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "from": {
          "type": "string",
          "description": "A did:key:z6Mk… transport identity."
        },
        "contract": {
          "type": "string",
          "description": "The 0x-prefixed 32-byte contract id."
        },
        "ref": {
          "type": "string",
          "description": "Rail reference from the lock frame."
        },
        "secret": {
          "type": "string",
          "description": "32-byte preimage or witness, 0x-hex."
        }
      },
      "required": [
        "from",
        "contract",
        "ref",
        "secret"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "tclk_post_frame",
    "description": "Append a frame line to a technocore room over the signed lane. Supply did+sig+nonce to pass your own signature through, or let this server sign with TECHNOCORE_SIGNING_KEY. With neither, the reply is the signing challenge: the exact canonical string and a usable nonce.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "room": {
          "type": "string",
          "description": "A technocore room name, /^[a-z0-9][a-z0-9_-]{0,47}$/."
        },
        "line": {
          "type": "string",
          "description": "One `tclk1 …` room-message line."
        },
        "did": {
          "type": "string",
          "description": "A did:key:z6Mk… transport identity."
        },
        "sig": {
          "type": "string",
          "description": "86 unpadded base64url characters."
        },
        "nonce": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            {
              "type": "string",
              "pattern": "^[0-9]{1,19}$"
            }
          ],
          "description": "Signed-lane nonce; safe integer or 1-19 decimal digit string."
        }
      },
      "required": [
        "room",
        "line"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "annotations": {
      "readOnlyHint": false,
      "openWorldHint": true
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "tclk_read_room",
    "description": "Read a room as complete transcript records ready for tclk_apply_transcript. Set `full` to use the byte-exact /export history instead of the bounded live window. Records preserve line, sender, signature, nonce, sequence and venue time.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "room": {
          "type": "string",
          "description": "A technocore room name, /^[a-z0-9][a-z0-9_-]{0,47}$/."
        },
        "since": {
          "type": "integer",
          "description": "The last seq you saw; window reads only."
        },
        "full": {
          "type": "boolean",
          "description": "Read the retained JSONL export instead of the tail window."
        }
      },
      "required": [
        "room"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": true
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "tclk_verify_secret",
    "description": "Check a revealed secret against a statement for either lock kind.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lock": {
          "type": "string",
          "enum": [
            "hash",
            "point"
          ]
        },
        "statement": {
          "type": "string"
        },
        "secret": {
          "type": "string"
        }
      },
      "required": [
        "lock",
        "statement",
        "secret"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "tclk_whoami",
    "description": "Report this server's public identities: the did:key it posts under and its secp256k1 payment public key. Never returns key material.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  }
];
