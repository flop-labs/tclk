import { connectFlopRail, type FlopRail } from "@flop-labs/tclk-flop";
import type { SettlementRail } from "@flop-labs/tclk";

// Resolve the built package through its exports map, as a wallet consumer does.
async function connect(): Promise<SettlementRail> {
  const connection = await connectFlopRail();
  const rail: FlopRail = connection.rail;
  await connection.disconnect();
  return rail;
}

void connect;
