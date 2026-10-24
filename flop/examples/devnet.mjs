// SPDX-License-Identifier: Apache-2.0
// Uses existing local Ed25519 keys. Requests test tokens only with --fund, only on devnet.
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { base58 } from "@scure/base";
import {
  makeOffer,
  makeAccept,
  openContract,
  applyFrame,
  lockTerms,
  generateHashLock,
} from "@flop-labs/tclk";
import { connectFlopRail, FlopLockError } from "../dist/index.js";

await cryptoWaitReady();
const keyring = new Keyring({ type: "ed25519", ss58Format: 42 });
function wallet(name) {
  const seed = process.env[name];
  if (!/^0x[0-9a-f]{64}$/.test(seed ?? ""))
    throw new Error(`${name} must be a 32-byte hex Ed25519 seed`);
  return keyring.addFromSeed(Buffer.from(seed.slice(2), "hex"));
}
const payer = wallet("FLOP_PAYER_SEED");
const payee = wallet("FLOP_PAYEE_SEED");
const did = (pair) =>
  `did:key:z${base58.encode(Uint8Array.from([0xed, 1, ...pair.publicKey]))}`;
const config = {
  network: process.env.FLOP_NETWORK ?? "devnet",
  rpcUrl: process.env.FLOP_RPC_URL,
  expectedGenesisHash: process.env.FLOP_GENESIS_HASH,
};
if (config.network !== "devnet")
  throw new Error("This test-token exercise only runs on devnet");
if (payer.address === payee.address)
  throw new Error("Use distinct payer and payee keys");
if (process.argv.includes("--fund")) {
  const identity = await (
    await fetch("https://faucet.flop.network/chain", {
      signal: AbortSignal.timeout(15000),
    })
  ).json();
  if (
    identity.network !== "devnet" ||
    (config.expectedGenesisHash &&
      config.expectedGenesisHash !== identity.genesisHash)
  )
    throw new Error("Faucet chain identity mismatch");
  config.expectedGenesisHash = identity.genesisHash;
  for (const pair of [payer, payee]) {
    let response = await fetch("https://faucet.flop.network/fund", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: pair.address, amount: 2, source: "sdk" }),
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      if (Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 120) {
        console.log(JSON.stringify({ stage: "faucet-wait", seconds }));
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        response = await fetch("https://faucet.flop.network/fund", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            address: pair.address,
            amount: 2,
            source: "sdk",
          }),
          signal: AbortSignal.timeout(30000),
        });
      }
    }
    const result = await response.json();
    if (!response.ok || result.success !== true)
      throw new Error(
        `Faucet refused ${pair.address}: ${response.status} ${result.error ?? ""}`,
      );
    console.log(
      JSON.stringify({
        stage: "funded",
        address: pair.address,
        txHash: result.txHash,
      }),
    );
  }
}
const a = await connectFlopRail({
  ...config,
  signer: payer,
  persistPending: async (pendingRef) => {
    console.log(JSON.stringify({ stage: "prepared", pendingRef }));
  },
});
let b;
try {
  b = await connectFlopRail({
    ...config,
    expectedGenesisHash: a.rail.config.expectedGenesisHash,
    signer: payee,
  });
  const createTerms = (claimWindowMs = 180000, refundWindowMs = 240000) => {
    const now = Date.now();
    const { preimage, hash } = generateHashLock();
    const offer = makeOffer({
      from: did(payer),
      role: "payer",
      lock: "hash",
      amount: "1000000000000000",
      asset: "FLOP",
      rails: ["flop-htlc"],
      claimByMs: now + claimWindowMs,
      refundAfterMs: now + refundWindowMs,
      expiresMs: now + 30000,
    });
    const accept = makeAccept(offer, { from: did(payee), statement: hash });
    const state = applyFrame(openContract(offer), accept, now);
    if (!state.ok) throw new Error(state.reason);
    return { terms: lockTerms(state.state), preimage };
  };
  const deal = createTerms();
  const ref = await a.rail.lock(deal.terms);
  console.log(JSON.stringify({ stage: "locked", ref })); // Public recovery data; never log the preimage.
  if (!(await b.rail.verifyLock(deal.terms, ref)))
    throw new Error("Payee rejected escrow");
  await b.rail.claim(ref, deal.preimage);
  console.log(
    JSON.stringify({ stage: "claimed", contract: deal.terms.contract }),
  );
  // Wide enough to clear the rail's 90 s claim-window floor: a 45 s window was consumed by
  // inclusion and finality on devnet, leaving the escrow Open until a manual refund.
  const expiry = createTerms(120000, 150000);
  const refundRef = await a.rail.lock(expiry.terms);
  console.log(JSON.stringify({ stage: "refund-pending", ref: refundRef }));
  // Refund needs refundAfterMs, then refundMarginBlocks more blocks, then finality.
  const end = expiry.terms.refundAfterMs + 120000;
  while (true) {
    try {
      await a.rail.refund(refundRef);
      break;
    } catch (error) {
      if (
        error.message !== "flop: refund window is not open" ||
        Date.now() >= end
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  console.log(
    JSON.stringify({
      stage: "refunded",
      contract: expiry.terms.contract,
      genesis: a.rail.config.expectedGenesisHash,
    }),
  );
} catch (error) {
  if (error instanceof FlopLockError)
    console.error(JSON.stringify({ stage: "recovery", ref: error.ref }));
  throw error;
} finally {
  await b?.disconnect();
  await a.disconnect();
}
