/**
 * ODATANO Raw Ogmios UTxO Latency Test
 *
 * Directly calls Ogmios via @cardano-ogmios/client to measure raw UTxO fetch
 * latency — no ODATANO server, no caching, no routing. Pure Ogmios WebSocket.
 *
 * Usage:
 *   npx tsx scripts/perf-ogmios-raw.ts
 *   npx tsx scripts/perf-ogmios-raw.ts --rounds 20
 */

import {
  createInteractionContext,
  createLedgerStateQueryClient,
} from "@cardano-ogmios/client";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const ROUNDS = parseInt(getArg("rounds", "10"), 10);
const OGMIOS_URL = process.env.OGMIOS_URL || "ws://localhost:1337";

// Test addresses (same as benchmark)
const ADDRESSES = [
  { label: "regular", address: "addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8" },
  { label: "funds",   address: "addr_test1qrgfq5jeznaehnf4zs02laas2juuuyzlz48tkue50luuws2nrznmesueg7drstsqaaenq6qpcnvqvn0kessd9fw2wxys6tv622" },
  { label: "plutus",  address: "addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp" },
];

(async () => {
  console.log(`\n  Raw Ogmios UTxO Latency Test`);
  console.log(`  Ogmios: ${OGMIOS_URL}`);
  console.log(`  Rounds: ${ROUNDS} per address`);
  console.log(`  Addresses: ${ADDRESSES.length}\n`);

  // Connect
  const url = new URL(OGMIOS_URL);
  const connection = {
    host: url.hostname,
    port: Number(url.port) || 80,
    tls: url.protocol === "wss:",
  };

  console.log("  Connecting to Ogmios...");
  const connectStart = performance.now();
  const context = await createInteractionContext(
    (err) => console.error(`  Context error: ${err.message}`),
    (err) => console.error(`  Connection error: ${err}`),
    { connection }
  );
  const stateQueryClient = await createLedgerStateQueryClient(context);
  const connectMs = Math.round((performance.now() - connectStart) * 100) / 100;
  console.log(`  Connected in ${connectMs}ms\n`);

  console.log("━".repeat(80));
  console.log(`  ${"Address".padEnd(20)}${"Round".padStart(8)}${"Time".padStart(10)}${"UTxOs".padStart(8)}`);
  console.log("━".repeat(80));

  const results: Array<{ label: string; rounds: number[]; utxoCount: number }> = [];

  for (const { label, address } of ADDRESSES) {
    const durations: number[] = [];
    let utxoCount = 0;

    for (let r = 1; r <= ROUNDS; r++) {
      const start = performance.now();
      const utxos = await stateQueryClient.utxo({ addresses: [address] });
      const ms = Math.round((performance.now() - start) * 100) / 100;
      durations.push(ms);
      utxoCount = utxos.length;
      console.log(`  ${label.padEnd(20)}${String(r).padStart(8)}${(ms.toFixed(1) + "ms").padStart(10)}${String(utxoCount).padStart(8)}`);
    }

    results.push({ label, rounds: durations, utxoCount });
    console.log("─".repeat(80));
  }

  // Summary
  console.log(`\n${"═".repeat(80)}`);
  console.log(`  SUMMARY`);
  console.log("═".repeat(80));
  console.log(`  ${"Address".padEnd(20)}${"UTxOs".padStart(8)}${"Cold".padStart(10)}${"Warm Avg".padStart(12)}${"Min".padStart(10)}${"Max".padStart(10)}${"Avg".padStart(10)}`);
  console.log("─".repeat(80));

  for (const r of results) {
    const cold = r.rounds[0];
    const warm = r.rounds.slice(1);
    const warmAvg = warm.length > 0 ? warm.reduce((a, b) => a + b, 0) / warm.length : cold;
    const all = r.rounds;
    const avg = all.reduce((a, b) => a + b, 0) / all.length;
    const min = Math.min(...all);
    const max = Math.max(...all);
    console.log(
      `  ${r.label.padEnd(20)}${String(r.utxoCount).padStart(8)}${(cold.toFixed(1) + "ms").padStart(10)}${(warmAvg.toFixed(1) + "ms").padStart(12)}${(min.toFixed(1) + "ms").padStart(10)}${(max.toFixed(1) + "ms").padStart(10)}${(avg.toFixed(1) + "ms").padStart(10)}`
    );
  }
  console.log("═".repeat(80));

  // Cleanup
  try {
    if ((context as any).socket) {
      (context as any).socket.terminate();
    }
  } catch {}

  console.log(`\n  Connection time: ${connectMs}ms`);
  console.log(`  Done.\n`);
})();
