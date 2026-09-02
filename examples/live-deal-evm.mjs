#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// One tclk/1 deal, end to end, settled on a real (local) chain instead of rehearsed.
//
// Same choreography as live-deal.mjs — offer, accept, lock, reveal — but the rail is
// contracts/EvmHashRail.sol on a throwaway anvil chain this script starts itself, and the
// hash lock it settles actually moves an ERC20 balance from payer to payee. No venue: this
// exercises the settlement leg, which is the part live-deal.mjs's PaperRail cannot.
//
//   forge build && pnpm build && node examples/live-deal-evm.mjs
//
// Requires `anvil` on PATH (comes with Foundry: https://getfoundry.sh).
// Set ANVIL_URL to point at a chain you're already running instead of spawning one.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  createPublicClient, createWalletClient, http, getAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

import {
  applyFrame, generateHashLock, lockTerms, makeAccept, makeOffer, openContract,
} from "../dist/index.js";
import { EvmHashRail } from "../dist/evm-hash-rail.js";
import { signerFromSeed } from "../mcp/dist/signing.js";

const log = (step, detail) => console.log(`${String(step).padEnd(3)} ${detail}`);

function artifact(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url)));
}
const EvmHashRailArtifact = artifact("../out/EvmHashRail.sol/EvmHashRail.json");
const MockERC20Artifact = artifact("../out/MockERC20.sol/MockERC20.json");

const RPC_URL = process.env.ANVIL_URL ?? "http://127.0.0.1:8545";
let anvil = null;

/** Spawn anvil and wait for both RPC readiness and its printed dev account keys. */
async function startAnvil() {
  if (process.env.ANVIL_URL) return [];
  anvil = spawn("anvil", ["--port", new URL(RPC_URL).port || "8545"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  anvil.stdout.on("data", (chunk) => { out += chunk; });
  anvil.stderr.on("data", (chunk) => { out += chunk; });
  anvil.on("error", (err) => {
    console.error(`\nCould not start anvil (${err.message}). Install Foundry: https://getfoundry.sh`);
    process.exit(1);
  });

  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (res.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error("anvil did not become ready within 15s");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const keys = [...out.matchAll(/^\(\d+\)\s+(0x[0-9a-fA-F]{64})\s*$/gm)].map((m) => m[1]);
  if (keys.length < 2) throw new Error("could not parse anvil's dev account private keys from its output");
  return keys;
}

function stopAnvil() {
  anvil?.kill();
}
process.on("exit", stopAnvil);
process.on("SIGINT", () => { stopAnvil(); process.exit(130); });

try {
  const devKeys = await startAnvil();
  log("", `chain      ${RPC_URL}`);

  const publicClient = createPublicClient({ chain: foundry, transport: http(RPC_URL) });
  const payerAccount = privateKeyToAccount(devKeys[0]);
  const payeeAccount = privateKeyToAccount(devKeys[1]);
  const payerEvm = createWalletClient({ chain: foundry, transport: http(RPC_URL), account: payerAccount });
  const payeeEvm = createWalletClient({ chain: foundry, transport: http(RPC_URL), account: payeeAccount });

  // The tclk-level identities are unrelated key material (Ed25519 DIDs) from the EVM
  // accounts above (secp256k1) — exactly the gap AddressBook exists to bridge.
  const payer = signerFromSeed(randomBytes(32));
  const payee = signerFromSeed(randomBytes(32));
  log("", `payer did  ${payer.did}`);
  log("", `payer evm  ${payerAccount.address}`);
  log("", `payee did  ${payee.did}`);
  log("", `payee evm  ${payeeAccount.address}`);
  console.log();

  // 0 — deploy the token and the rail. Any funded account can deploy; here, the payer.
  const tokenDeployHash = await payerEvm.deployContract({
    abi: MockERC20Artifact.abi,
    bytecode: MockERC20Artifact.bytecode.object,
  });
  const { contractAddress: token } = await publicClient.waitForTransactionReceipt({ hash: tokenDeployHash });

  const railDeployHash = await payerEvm.deployContract({
    abi: EvmHashRailArtifact.abi,
    bytecode: EvmHashRailArtifact.bytecode.object,
  });
  const { contractAddress: railAddress } = await publicClient.waitForTransactionReceipt({ hash: railDeployHash });
  log(0, `deployed   MockERC20 ${token}`);
  log("", `           EvmHashRail ${railAddress}`);

  const amount = 1_000_000n; // 1.0 FLOP at the mock token's 6 decimals
  await publicClient.waitForTransactionReceipt({
    hash: await payerEvm.writeContract({
      address: token, abi: MockERC20Artifact.abi, functionName: "mint",
      args: [payerAccount.address, amount],
    }),
  });
  await publicClient.waitForTransactionReceipt({
    hash: await payerEvm.writeContract({
      address: token, abi: MockERC20Artifact.abi, functionName: "approve",
      args: [railAddress, amount],
    }),
  });
  log("", `funded     payer minted ${amount} FLOP, approved the rail`);

  const addressBook = {
    resolve(did) {
      if (did === payer.did) return payerAccount.address;
      if (did === payee.did) return payeeAccount.address;
      throw new Error(`tclk: no known EVM address for ${did}`);
    },
  };
  const assetBook = {
    resolve(asset) {
      if (asset === "FLOP") return getAddress(token);
      throw new Error(`tclk: no known EVM token for asset ${asset}`);
    },
  };
  const payerRail = new EvmHashRail({
    publicClient, walletClient: payerEvm, contractAddress: railAddress, addressBook, assetBook,
  });
  const payeeRail = new EvmHashRail({
    publicClient, walletClient: payeeEvm, contractAddress: railAddress, addressBook, assetBook,
  });

  // 1 — the payer states terms; the payee mints the secret and states only its hash.
  const now = Date.now();
  const offer = makeOffer({
    from: payer.did, role: "payer", lock: "hash", amount: String(amount), asset: "FLOP",
    rails: ["evm-htlc"],
    claimByMs: now + 30 * 60_000, refundAfterMs: now + 60 * 60_000, expiresMs: now + 10 * 60_000,
  });
  const lock = generateHashLock();
  const accept = makeAccept(offer, { from: payee.did, statement: lock.hash });
  log(1, `offer      ${offer.id.slice(0, 18)}…  accept  contract ${accept.contract.slice(0, 18)}…`);

  let payerView = applyFrame(openContract(offer), accept, Date.now()).state;
  let payeeView = applyFrame(openContract(offer), accept, Date.now()).state;

  // 2 — the payer escrows on-chain.
  const balanceBefore = {
    payer: await publicClient.readContract({ address: token, abi: MockERC20Artifact.abi, functionName: "balanceOf", args: [payerAccount.address] }),
    payee: await publicClient.readContract({ address: token, abi: MockERC20Artifact.abi, functionName: "balanceOf", args: [payeeAccount.address] }),
  };

  const ref = await payerRail.lock(lockTerms(payerView));
  const lockFrame = { type: "lock", from: payer.did, contract: accept.contract, rail: "evm-htlc", ref };
  payerView = applyFrame(payerView, lockFrame, Date.now()).state;
  payeeView = applyFrame(payeeView, lockFrame, Date.now()).state;
  log(2, `lock       escrowed on-chain, ref ${ref.slice(0, 18)}…`);

  const held = await payeeRail.verifyLock(lockTerms(payeeView), ref);
  log("", `payee checked the rail itself → verifyLock ${held}`);
  if (!held) throw new Error("rail does not hold the lock the frame claims");

  // 3 — the payee reveals and claims. Publishing the secret and calling claim are the
  // same act here — there is no venue to publish it to, so the on-chain claim tx is the
  // reveal.
  const revealFrame = { type: "reveal", from: payee.did, contract: accept.contract, secret: lock.preimage };
  payerView = applyFrame(payerView, revealFrame, Date.now()).state;
  payeeView = applyFrame(payeeView, revealFrame, Date.now()).state;
  await payeeRail.claim(ref, lock.preimage);
  log(3, `reveal     secret published on-chain, rail record → claimed`);

  const balanceAfter = {
    payer: await publicClient.readContract({ address: token, abi: MockERC20Artifact.abi, functionName: "balanceOf", args: [payerAccount.address] }),
    payee: await publicClient.readContract({ address: token, abi: MockERC20Artifact.abi, functionName: "balanceOf", args: [payeeAccount.address] }),
  };

  console.log();
  log(4, "balances:");
  log("", `payer   ${balanceBefore.payer} → ${balanceAfter.payer}  (${balanceAfter.payer - balanceBefore.payer >= 0n ? "+" : ""}${balanceAfter.payer - balanceBefore.payer})`);
  log("", `payee   ${balanceBefore.payee} → ${balanceAfter.payee}  (+${balanceAfter.payee - balanceBefore.payee})`);

  if (payerView.status !== "claimed" || payeeView.status !== "claimed") {
    throw new Error(`expected both views claimed, got payer=${payerView.status} payee=${payeeView.status}`);
  }
  if (balanceAfter.payee - balanceBefore.payee !== amount) {
    throw new Error("payee balance did not increase by the locked amount");
  }
  if (balanceBefore.payer - balanceAfter.payer !== amount) {
    throw new Error("payer balance did not decrease by the locked amount");
  }

  console.log();
  console.log(`Deal complete. ${amount} FLOP moved payer → payee on-chain, both tclk views agree: claimed.`);
} finally {
  stopAnvil();
}
