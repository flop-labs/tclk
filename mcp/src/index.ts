// SPDX-License-Identifier: Apache-2.0
//
// Library entry: embed the tclk/1 tools in another MCP server, or call the handlers
// directly. The stdio binary is `./cli.js`.

export { createServer, createHandlers } from "./server.js";
export type { Handlers, HandlerOptions, TclkEnv } from "./server.js";
export type { MakeOfferInput, AcceptOfferInput, PostFrameInput } from "./tools.js";

export {
  canonicalMessage,
  didFromPublicKey,
  loadSigner,
  nextNonce,
  signerFromSeed,
  sweep,
  DID_PREFIX,
} from "./signing.js";
export type { Signer } from "./signing.js";

export { createClient, assertRoomName, DEFAULT_TECHNOCORE_URL } from "./technocore.js";
export type { FetchLike, RoomMessage, RoomView, SignedPost, TechnocoreClient } from "./technocore.js";
