/**
 * ODATANO UTxO Fetch Benchmark
 *
 * Isolates UTxO fetching performance: Blockfrost vs Ogmios+Blockfrost.
 * Only calls GetUTxOsByAddress (read endpoint) — no TX building, no evaluation.
 * This helps determine whether the Ogmios overhead comes from UTxO routing
 * or from ExUnit evaluation during TX builds.
 *
 * Prerequisites:
 *   - .env with BLOCKFROST_API_KEY and OGMIOS_URL
 *   - Ogmios node running on OGMIOS_URL
 *
 * Usage:
 *   npx tsx scripts/perf-utxo-fetch.ts
 *   npx tsx scripts/perf-utxo-fetch.ts --rounds 10
 */

import { spawn, execSync, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import axios from "axios";
import {
  CallResult,
  EndpointResult,
  BenchmarkReport,
  callEndpoint,
  computeStats,
} from "./perf-benchmark";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const ROUNDS = parseInt(getArg("rounds", "10"), 10);
const PORT = parseInt(getArg("port", "4005"), 10);
const BASE = `http://localhost:${PORT}`;
const OUTPUT = getArg("output", path.join(__dirname, "perf-utxo-fetch-results.json"));
const AUTH_HEADER = "Basic " + Buffer.from("alice:").toString("base64");
const OGMIOS_URL = process.env.OGMIOS_URL || "ws://localhost:1337";

// Test addresses
const ADDR = "addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8";
const ADDR_WITH_FUNDS = "addr_test1qrgfq5jeznaehnf4zs02laas2juuuyzlz48tkue50luuws2nrznmesueg7drstsqaaenq6qpcnvqvn0kessd9fw2wxys6tv622";
const ADDR_PLUTUS = "addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp";

interface BackendConfig {
  name: string;
  env: Record<string, string>;
}

const CONFIGS: BackendConfig[] = [
  {
    name: "blockfrost_only",
    env: {
      BACKENDS: "blockfrost",
      BLOCKFROST_API_KEY: process.env.BLOCKFROST_API_KEY || "",
      KOIOS_API_KEY: "",
      OGMIOS_URL: "",
      TX_BUILDERS: "buildooor",
    },
  },
  {
    name: "ogmios+blockfrost",
    env: {
      BACKENDS: "ogmios,blockfrost",
      OGMIOS_URL: OGMIOS_URL,
      BLOCKFROST_API_KEY: process.env.BLOCKFROST_API_KEY || "",
      KOIOS_API_KEY: "",
      TX_BUILDERS: "buildooor",
    },
  },
];

// --- Server lifecycle (reused from perf-compare.ts) ---

async function waitForServer(maxWaitMs: number = 120_000): Promise<number> {
  const start = Date.now();
  const healthUrl = `${BASE}/odata/v4/cardano-odata/NetworkInformation`;
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await axios.get(healthUrl, {
        timeout: 3000,
        headers: { Authorization: AUTH_HEADER },
      });
      if (res.status === 200) return Date.now() - start;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Server did not start within ${maxWaitMs / 1000}s`);
}

function startServer(config: BackendConfig): ChildProcess {
  const env = { ...process.env, ...config.env, PORT: String(PORT), NODE_ENV: "development" };
  const proc = spawn("npx", ["cds", "watch", "--port", String(PORT)], {
    env, stdio: ["ignore", "pipe", "pipe"], shell: true, cwd: path.join(__dirname, ".."),
  });
  proc.stdout?.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n").filter((l) => l.trim())) {
      if (line.includes("[cds]") || line.includes("error") || line.includes("Error"))
        process.stderr.write(`  [${config.name}] ${line}\n`);
    }
  });
  proc.stderr?.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n").filter((l) => l.trim())) {
      if (line.includes("error") || line.includes("Error") || line.includes("EADDRINUSE"))
        process.stderr.write(`  [${config.name}] ERR: ${line}\n`);
    }
  });
  return proc;
}

function cleanDatabase() {
  const projectDir = path.join(__dirname, "..");
  for (const file of ["db.sqlite", "db.sqlite-shm", "db.sqlite-wal"]) {
    try { fs.unlinkSync(path.join(projectDir, file)); } catch {}
  }
  execSync("npx cds deploy", { cwd: projectDir, stdio: "ignore" });
}

async function killServer(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!proc.pid) { resolve(); return; }
    proc.on("exit", () => resolve());
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", shell: true });
    } else {
      proc.kill("SIGTERM");
    }
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} resolve(); }, 5000);
  });
}

// --- UTxO-only benchmark ---

function buildUtxoEndpoints(base: string) {
  const ODATA = `${base}/odata/v4/cardano-odata`;
  return [
    { name: "GetUTxOsByAddress(regular)", method: "POST" as const, url: `${ODATA}/GetUTxOsByAddress`, data: { address: ADDR }, category: "address" as const },
    { name: "GetUTxOsByAddress(funds)", method: "POST" as const, url: `${ODATA}/GetUTxOsByAddress`, data: { address: ADDR_WITH_FUNDS }, category: "address" as const },
    { name: "GetUTxOsByAddress(plutus)", method: "POST" as const, url: `${ODATA}/GetUTxOsByAddress`, data: { address: ADDR_PLUTUS }, category: "address" as const },
    { name: "GetAddressByBech32(regular)", method: "POST" as const, url: `${ODATA}/GetAddressByBech32`, data: { address: ADDR }, category: "address" as const },
    { name: "GetAddressByBech32(funds)", method: "POST" as const, url: `${ODATA}/GetAddressByBech32`, data: { address: ADDR_WITH_FUNDS }, category: "address" as const },
    { name: "GetAssetsByAddress(regular)", method: "POST" as const, url: `${ODATA}/GetAssetsByAddress`, data: { address: ADDR }, category: "address" as const },
    { name: "GetAssetsByAddress(funds)", method: "POST" as const, url: `${ODATA}/GetAssetsByAddress`, data: { address: ADDR_WITH_FUNDS }, category: "address" as const },
  ];
}

async function runUtxoBenchmark(base: string, rounds: number): Promise<BenchmarkReport> {
  const endpoints = buildUtxoEndpoints(base);

  console.log(`    Running ${rounds} rounds x ${endpoints.length} UTxO/Address endpoints...\n`);

  const results: EndpointResult[] = [];

  for (const ep of endpoints) {
    const epRounds: CallResult[] = [];
    process.stdout.write(`    ${ep.name.padEnd(40)}`);

    for (let r = 1; r <= rounds; r++) {
      const res = await callEndpoint(ep);
      epRounds.push({ round: r, ...res });
      process.stdout.write(res.error ? "x" : ".");
    }

    const stats = computeStats(epRounds);
    results.push({ name: ep.name, category: ep.category, method: ep.method, rounds: epRounds, stats });
    const errCount = epRounds.filter((r) => !!r.error).length;
    const errSuffix = errCount > 0 ? `  [${errCount} failed]` : "";
    console.log(`  avg=${stats.avg.toFixed(1)}ms  cold=${stats.coldStart.toFixed(1)}ms  warm=${stats.warmAvg.toFixed(1)}ms${errSuffix}`);
  }

  const allDurations = results.flatMap((r) => r.rounds.map((c) => c.durationMs));
  const successCount = results.reduce((s, r) => s + r.rounds.filter((c) => !c.error).length, 0);
  const failCount = results.reduce((s, r) => s + r.rounds.filter((c) => !!c.error).length, 0);
  const avgAll = allDurations.length > 0 ? Math.round((allDurations.reduce((a, b) => a + b, 0) / allDurations.length) * 100) / 100 : 0;
  const byAvg = [...results].sort((a, b) => a.stats.avg - b.stats.avg);

  return {
    timestamp: new Date().toISOString(),
    config: { rounds, baseUrl: base },
    results,
    summary: {
      totalEndpoints: results.length,
      totalCalls: results.reduce((s, r) => s + r.rounds.length, 0),
      successfulCalls: successCount,
      failedCalls: failCount,
      avgResponseMs: avgAll,
      slowest: { name: byAvg[byAvg.length - 1]?.name ?? "", avgMs: byAvg[byAvg.length - 1]?.stats.avg ?? 0 },
      fastest: { name: byAvg[0]?.name ?? "", avgMs: byAvg[0]?.stats.avg ?? 0 },
    },
  };
}

// --- Main ---

(async () => {
  console.log(`\n  ODATANO UTxO Fetch Benchmark`);
  console.log(`  Purpose: Isolate UTxO routing overhead (no TX building, no evaluation)`);
  console.log(`  Configs: ${CONFIGS.map((c) => c.name).join(" vs ")}`);
  console.log(`  Rounds: ${ROUNDS} per endpoint`);
  console.log(`  Port: ${PORT}\n`);

  if (!CONFIGS[0].env.BLOCKFROST_API_KEY) {
    console.error("  ERROR: BLOCKFROST_API_KEY not set in .env");
    process.exit(1);
  }
  if (!CONFIGS[1].env.OGMIOS_URL) {
    console.error("  ERROR: OGMIOS_URL not set in .env");
    process.exit(1);
  }

  const compareResult: { timestamp: string; configs: Array<{ name: string; startupMs: number; report: BenchmarkReport }> } = {
    timestamp: new Date().toISOString(),
    configs: [],
  };

  for (const config of CONFIGS) {
    console.log(`\n${"━".repeat(80)}`);
    console.log(`  ${config.name.toUpperCase()}`);
    console.log(`  Backends: ${config.env.BACKENDS}`);
    console.log(`  Ogmios UTxO routing: ${config.env.OGMIOS_URL ? "ENABLED (preferLive → Ogmios)" : "DISABLED (Blockfrost only)"}`);
    console.log("━".repeat(80));

    cleanDatabase();
    const proc = startServer(config);

    try {
      console.log(`  Waiting for server...`);
      const startupMs = await waitForServer();
      console.log(`  Server ready in ${(startupMs / 1000).toFixed(1)}s\n`);
      await new Promise((r) => setTimeout(r, 2000));

      const report = await runUtxoBenchmark(BASE, ROUNDS);
      report.backend = config.name;
      report.startupMs = startupMs;
      compareResult.configs.push({ name: config.name, startupMs, report });
    } catch (err: any) {
      console.error(`  ERROR: ${err.message}`);
    } finally {
      console.log(`\n  Stopping ${config.name}...`);
      await killServer(proc);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // --- Print comparison ---
  if (compareResult.configs.length === 2) {
    const [bf, ogm] = compareResult.configs;

    console.log(`\n${"═".repeat(80)}`);
    console.log(`  UTxO FETCH: ${bf.name} vs ${ogm.name}`);
    console.log(`  (No TX building, no ExUnit evaluation — pure UTxO/Address reads)`);
    console.log("═".repeat(80));

    console.log(`\n  ${"Endpoint".padEnd(40)}${"Blockfrost".padStart(12)}${"Ogmios+BF".padStart(12)}${"Diff".padStart(10)}${"Impact".padStart(10)}`);
    console.log("  " + "─".repeat(80));

    for (const r of bf.report.results) {
      const w = ogm.report.results.find((x) => x.name === r.name);
      if (!w) continue;
      const diff = w.stats.avg - r.stats.avg;
      const pct = r.stats.avg > 0 ? ((diff / r.stats.avg) * 100).toFixed(0) + "%" : "N/A";
      const impact = diff > 50 ? "SLOW" : diff < -10 ? "FAST" : "~same";
      console.log(
        `  ${r.name.padEnd(40)}${(r.stats.avg.toFixed(1) + "ms").padStart(12)}${(w.stats.avg.toFixed(1) + "ms").padStart(12)}${((diff >= 0 ? "+" : "") + diff.toFixed(0) + "ms").padStart(10)}${impact.padStart(10)}`
      );
    }

    // Warm-only comparison (skip cold start)
    console.log("\n  " + "─".repeat(80));
    console.log(`  ${"WARM ONLY (skip round 1)".padEnd(40)}${"Blockfrost".padStart(12)}${"Ogmios+BF".padStart(12)}${"Diff".padStart(10)}`);
    console.log("  " + "─".repeat(80));

    for (const r of bf.report.results) {
      const w = ogm.report.results.find((x) => x.name === r.name);
      if (!w) continue;
      const diff = w.stats.warmAvg - r.stats.warmAvg;
      console.log(
        `  ${r.name.padEnd(40)}${(r.stats.warmAvg.toFixed(1) + "ms").padStart(12)}${(w.stats.warmAvg.toFixed(1) + "ms").padStart(12)}${((diff >= 0 ? "+" : "") + diff.toFixed(0) + "ms").padStart(10)}`
      );
    }

    console.log("\n  " + "─".repeat(80));
    console.log(
      `  ${"OVERALL AVG".padEnd(40)}${(bf.report.summary.avgResponseMs.toFixed(1) + "ms").padStart(12)}${(ogm.report.summary.avgResponseMs.toFixed(1) + "ms").padStart(12)}${(((ogm.report.summary.avgResponseMs - bf.report.summary.avgResponseMs >= 0 ? "+" : "") + (ogm.report.summary.avgResponseMs - bf.report.summary.avgResponseMs).toFixed(0)) + "ms").padStart(10)}`
    );
    console.log("═".repeat(80));
  }

  fs.writeFileSync(OUTPUT, JSON.stringify(compareResult, null, 2));
  console.log(`\n  Results saved to: ${OUTPUT}\n`);
})();
