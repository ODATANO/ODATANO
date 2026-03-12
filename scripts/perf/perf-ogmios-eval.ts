/**
 * ODATANO Ogmios Evaluation Impact Benchmark
 *
 * Compares TX-build performance with and without Ogmios evaluation:
 *   1. blockfrost_buildooor        — Blockfrost only, default ExUnits (no evaluation)
 *   2. ogmios+blockfrost_buildooor — Ogmios + Blockfrost, dynamic ExUnit evaluation via Ogmios
 *
 * Only runs TX-build endpoints to isolate the evaluation overhead.
 *
 * Prerequisites:
 *   - .env with BLOCKFROST_API_KEY and OGMIOS_URL
 *   - Ogmios node running on OGMIOS_URL
 *
 * Usage:
 *   npx tsx scripts/perf-ogmios-eval.ts
 *   npx tsx scripts/perf-ogmios-eval.ts --rounds 5
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
  buildEndpoints,
} from "./perf-benchmark";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const ROUNDS = parseInt(getArg("rounds", "5"), 10);
const PORT = parseInt(getArg("port", "4005"), 10);
const BASE = `http://localhost:${PORT}`;
const OUTPUT = getArg("output", path.join(__dirname, "perf-ogmios-eval-results.json"));
const AUTH_HEADER = "Basic " + Buffer.from("alice:").toString("base64");
const OGMIOS_URL = process.env.OGMIOS_URL || "ws://localhost:1337";

interface BackendConfig {
  name: string;
  env: Record<string, string>;
}

const CONFIGS: BackendConfig[] = [
  {
    name: "blockfrost_buildooor",
    env: {
      BACKENDS: "blockfrost",
      BLOCKFROST_API_KEY: process.env.BLOCKFROST_API_KEY || "",
      KOIOS_API_KEY: "",
      OGMIOS_URL: "",
      TX_BUILDERS: "buildooor",
    },
  },
  {
    name: "ogmios+blockfrost_buildooor",
    env: {
      BACKENDS: "ogmios,blockfrost",
      OGMIOS_URL: OGMIOS_URL,
      BLOCKFROST_API_KEY: process.env.BLOCKFROST_API_KEY || "",
      KOIOS_API_KEY: "",
      TX_BUILDERS: "buildooor",
    },
  },
];

// --- Server lifecycle (same as perf-compare.ts) ---

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
    } catch { }
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
    try { fs.unlinkSync(path.join(projectDir, file)); } catch { }
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
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch { } resolve(); }, 5000);
  });
}

// --- TX-only benchmark ---

async function runTxBenchmark(base: string, rounds: number): Promise<BenchmarkReport> {
  const allEndpoints = buildEndpoints(base);
  // Filter to tx-build category only (excludes signing, reads, entity GETs)
  const txEndpoints = allEndpoints.filter((ep) => ep.category === "tx-build");

  console.log(`    Running ${rounds} rounds x ${txEndpoints.length} TX-build endpoints...\n`);

  const results: EndpointResult[] = [];

  for (const ep of txEndpoints) {
    const epRounds: CallResult[] = [];
    process.stdout.write(`    ${ep.name.padEnd(35)}`);

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
  console.log(`\n  ODATANO Ogmios Evaluation Impact Benchmark`);
  console.log(`  Configs: ${CONFIGS.map((c) => c.name).join(" vs ")}`);
  console.log(`  Rounds: ${ROUNDS} per TX-build endpoint`);
  console.log(`  Port: ${PORT}\n`);

  // Validate
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
    console.log(`  Backends: ${config.env.BACKENDS} | Builder: ${config.env.TX_BUILDERS}`);
    console.log(`  Ogmios evaluation: ${config.env.OGMIOS_URL ? "ENABLED" : "DISABLED (default ExUnits)"}`);
    console.log("━".repeat(80));

    cleanDatabase();
    const proc = startServer(config);

    try {
      console.log(`  Waiting for server...`);
      const startupMs = await waitForServer();
      console.log(`  Server ready in ${(startupMs / 1000).toFixed(1)}s\n`);
      await new Promise((r) => setTimeout(r, 2000));

      const report = await runTxBenchmark(BASE, ROUNDS);
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
    const [noEval, withEval] = compareResult.configs;

    console.log(`\n${"═".repeat(80)}`);
    console.log(`  OGMIOS EVALUATION IMPACT: ${noEval.name} vs ${withEval.name}`);
    console.log("═".repeat(80));

    console.log(`\n  ${"Endpoint".padEnd(35)}${"No Eval".padStart(12)}${"With Eval".padStart(12)}${"Diff".padStart(10)}${"Impact".padStart(10)}`);
    console.log("  " + "─".repeat(75));

    for (const r of noEval.report.results) {
      const w = withEval.report.results.find((x) => x.name === r.name);
      if (!w) continue;
      const diff = w.stats.avg - r.stats.avg;
      const pct = r.stats.avg > 0 ? ((diff / r.stats.avg) * 100).toFixed(0) + "%" : "N/A";
      const impact = diff > 50 ? "SLOW" : diff < -10 ? "FAST" : "~same";
      console.log(
        `  ${r.name.padEnd(35)}${(r.stats.avg.toFixed(1) + "ms").padStart(12)}${(w.stats.avg.toFixed(1) + "ms").padStart(12)}${((diff >= 0 ? "+" : "") + diff.toFixed(0) + "ms").padStart(10)}${impact.padStart(10)}`
      );
    }

    console.log("\n  " + "─".repeat(75));
    console.log(
      `  ${"OVERALL AVG".padEnd(35)}${(noEval.report.summary.avgResponseMs.toFixed(1) + "ms").padStart(12)}${(withEval.report.summary.avgResponseMs.toFixed(1) + "ms").padStart(12)}${(((withEval.report.summary.avgResponseMs - noEval.report.summary.avgResponseMs >= 0 ? "+" : "") + (withEval.report.summary.avgResponseMs - noEval.report.summary.avgResponseMs).toFixed(0)) + "ms").padStart(10)}`
    );
    console.log("═".repeat(80));
  }

  fs.writeFileSync(OUTPUT, JSON.stringify(compareResult, null, 2));
  console.log(`\n  Results saved to: ${OUTPUT}\n`);
})();
