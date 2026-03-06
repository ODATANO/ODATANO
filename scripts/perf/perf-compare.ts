/**
 * ODATANO Backend Comparison Benchmark
 *
 * Automatically starts the server with different backend configs (Koios, Blockfrost),
 * runs the full benchmark against each, measures server startup time, and outputs
 * a side-by-side comparison.
 *
 * Prerequisites:
 *   - .env file with BLOCKFROST_API_KEY and KOIOS_API_KEY set
 *   - No other cds watch running on the same port
 *
 * Usage:
 *   npx tsx scripts/perf-compare.ts
 *   npx tsx scripts/perf-compare.ts --rounds 5
 *   npx tsx scripts/perf-compare.ts --port 4005
 */

import { spawn, execSync, ChildProcess } from "child_process";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { runBenchmark, BenchmarkReport } from "./perf-benchmark";

// Load .env
dotenv.config({ path: path.join(__dirname, "..", ".env") });

// --- Config ---

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const ROUNDS = parseInt(getArg("rounds", "3"), 10);
const PORT = parseInt(getArg("port", "4005"), 10);
const OUTPUT = getArg(
  "output",
  path.join(__dirname, "perf-compare-results.json"),
);
const BASE = `http://localhost:${PORT}`;
const AUTH_HEADER = "Basic " + Buffer.from("alice:").toString("base64");

// --- Backend configurations ---

interface BackendConfig {
  name: string;
  env: Record<string, string>;
}

const OGMIOS_URL = process.env.OGMIOS_URL || "ws://localhost:1337";

const BACKEND_CONFIGS: BackendConfig[] = [
  {
    name: "koios_buildooor",
    env: {
      BACKENDS: "koios",
      KOIOS_API_KEY: process.env.KOIOS_API_KEY || "",
      BLOCKFROST_API_KEY: "", // clear to prevent fallback
      OGMIOS_URL: "", // clear to prevent fallback
      TX_BUILDERS: "buildooor",
    },
  },
  {
    name: "koios_csl",
    env: {
      BACKENDS: "koios",
      KOIOS_API_KEY: process.env.KOIOS_API_KEY || "",
      BLOCKFROST_API_KEY: "", // clear to prevent fallback
      OGMIOS_URL: "", // clear to prevent fallback
      TX_BUILDERS: "csl",
    },
  },
  {
    name: "blockfrost_buildooor",
    env: {
      BACKENDS: "blockfrost",
      BLOCKFROST_API_KEY: process.env.BLOCKFROST_API_KEY || "",
      KOIOS_API_KEY: "", // clear to prevent fallback
      OGMIOS_URL: "", // clear to prevent fallback
      TX_BUILDERS: "buildooor",
    },
  },
  {
    name: "blockfrost_csl",
    env: {
      BACKENDS: "blockfrost",
      BLOCKFROST_API_KEY: process.env.BLOCKFROST_API_KEY || "",
      KOIOS_API_KEY: "", // clear to prevent fallback
      OGMIOS_URL: "", // clear to prevent fallback
      TX_BUILDERS: "csl",
    },
  },
  {
    name: "ogmios+koios_buildooor",
    env: {
      BACKENDS: "ogmios,koios",
      OGMIOS_URL: OGMIOS_URL,
      KOIOS_API_KEY: process.env.KOIOS_API_KEY || "",
      BLOCKFROST_API_KEY: "", // clear to prevent fallback
      TX_BUILDERS: "buildooor",
    },
  },
  {
    name: "ogmios+koios_csl",
    env: {
      BACKENDS: "ogmios,koios",
      OGMIOS_URL: OGMIOS_URL,
      KOIOS_API_KEY: process.env.KOIOS_API_KEY || "",
      BLOCKFROST_API_KEY: "", // clear to prevent fallback
      TX_BUILDERS: "csl",
    },
  },
  {
    name: "ogmios+blockfrost_buildooor",
    env: {
      BACKENDS: "ogmios,blockfrost",
      OGMIOS_URL: OGMIOS_URL,
      BLOCKFROST_API_KEY: process.env.BLOCKFROST_API_KEY || "",
      KOIOS_API_KEY: "", // clear to prevent fallback
      TX_BUILDERS: "buildooor",
    },
  },
  {
    name: "ogmios+blockfrost_csl",
    env: {
      BACKENDS: "ogmios,blockfrost",
      OGMIOS_URL: OGMIOS_URL,
      BLOCKFROST_API_KEY: process.env.BLOCKFROST_API_KEY || "",
      KOIOS_API_KEY: "", // clear to prevent fallback
      TX_BUILDERS: "csl",
    },
  },
];

// --- Server management ---

async function waitForServer(maxWaitMs: number = 120_000): Promise<number> {
  const start = Date.now();
  const healthUrl = `${BASE}/odata/v4/cardano-odata/NetworkInformation`;

  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await axios.get(healthUrl, {
        timeout: 3000,
        headers: { Authorization: AUTH_HEADER },
      });
      if (res.status === 200) {
        return Date.now() - start;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Server did not start within ${maxWaitMs / 1000}s`);
}

function startServer(config: BackendConfig): ChildProcess {
  const env = {
    ...process.env,
    ...config.env,
    PORT: String(PORT),
    NODE_ENV: "development",
  };

  const proc = spawn("npx", ["cds", "watch", "--port", String(PORT)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    cwd: path.join(__dirname, ".."),
  });

  // Pipe server output for debugging (prefixed)
  proc.stdout?.on("data", (data: Buffer) => {
    const lines = data
      .toString()
      .split("\n")
      .filter((l) => l.trim());
    for (const line of lines) {
      // Only show important server messages
      if (
        line.includes("[cds]") ||
        line.includes("server listening") ||
        line.includes("error") ||
        line.includes("Error")
      ) {
        process.stderr.write(`  [${config.name}] ${line}\n`);
      }
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    const lines = data
      .toString()
      .split("\n")
      .filter((l) => l.trim());
    for (const line of lines) {
      if (
        line.includes("error") ||
        line.includes("Error") ||
        line.includes("EADDRINUSE")
      ) {
        process.stderr.write(`  [${config.name}] ERR: ${line}\n`);
      }
    }
  });

  return proc;
}

/** Delete SQLite database files and redeploy schema for a clean cache */
function cleanDatabase() {
  const projectDir = path.join(__dirname, "..");
  const dbFiles = ["db.sqlite", "db.sqlite-shm", "db.sqlite-wal"];
  for (const file of dbFiles) {
    const filePath = path.join(projectDir, file);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // File doesn't exist — that's fine
    }
  }
  // Redeploy schema so cds watch finds the tables
  execSync("npx cds deploy", { cwd: projectDir, stdio: "ignore" });
}

async function killServer(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!proc.pid) {
      resolve();
      return;
    }

    proc.on("exit", () => resolve());

    // On Windows, we need taskkill to kill the process tree
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
        shell: true,
      });
    } else {
      proc.kill("SIGTERM");
    }

    // Force kill after 5s
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
      resolve();
    }, 5000);
  });
}

// --- Comparison output ---

interface CompareResult {
  timestamp: string;
  config: { rounds: number; port: number };
  backends: Array<{
    name: string;
    startupMs: number;
    report: BenchmarkReport;
  }>;
}

function printComparison(result: CompareResult) {
  const backends = result.backends;
  const names = backends.map((b) => b.name);

  console.log("\n" + "═".repeat(90));
  console.log(`  ODATANO Backend Comparison: ${names.join(" vs ")}`);
  console.log(`  ${ROUNDS} rounds x endpoints per backend`);
  console.log("═".repeat(90));

  // Startup times
  console.log("\n  Server Startup Time:");
  for (const b of backends) {
    console.log(`    ${b.name.padEnd(15)} ${(b.startupMs / 1000).toFixed(1)}s`);
  }

  // Side-by-side endpoint comparison
  console.log("\n" + "─".repeat(90));
  const header = `  ${"Endpoint".padEnd(35)}${names.map((n) => n.padStart(15)).join("")}${"Diff".padStart(10)}`;
  console.log(header);
  console.log("─".repeat(90));

  // Get all endpoint names (union)
  const allEndpoints = new Set<string>();
  for (const b of backends) {
    for (const r of b.report.results) allEndpoints.add(r.name);
  }

  for (const epName of allEndpoints) {
    const avgs = backends.map((b) => {
      const ep = b.report.results.find((r) => r.name === epName);
      return ep ? ep.stats.avg : null;
    });

    const avgStrs = avgs.map((a) =>
      a !== null ? `${a.toFixed(1)}ms`.padStart(15) : "N/A".padStart(15),
    );

    let diffStr = "";
    if (avgs[0] !== null && avgs[1] !== null && avgs[0] > 0) {
      const pct = ((avgs[1] - avgs[0]) / avgs[0]) * 100;
      diffStr = `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`;
    }

    console.log(
      `  ${epName.padEnd(35)}${avgStrs.join("")}${diffStr.padStart(10)}`,
    );
  }

  // Category comparison
  console.log("\n" + "─".repeat(90));
  console.log(
    `  ${"Category".padEnd(35)}${names.map((n) => n.padStart(15)).join("")}${"Diff".padStart(10)}`,
  );
  console.log("─".repeat(90));

  const categories = [
    ...new Set(
      backends.flatMap((b) => b.report.results.map((r) => r.category)),
    ),
  ];
  for (const cat of categories) {
    const catAvgs = backends.map((b) => {
      const catResults = b.report.results.filter((r) => r.category === cat);
      if (catResults.length === 0) return null;
      return (
        Math.round(
          (catResults.reduce((s, r) => s + r.stats.avg, 0) /
            catResults.length) *
            100,
        ) / 100
      );
    });

    const catStrs = catAvgs.map((a) =>
      a !== null ? `${a.toFixed(1)}ms`.padStart(15) : "N/A".padStart(15),
    );

    let diffStr = "";
    if (catAvgs[0] !== null && catAvgs[1] !== null && catAvgs[0] > 0) {
      const pct = ((catAvgs[1] - catAvgs[0]) / catAvgs[0]) * 100;
      diffStr = `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`;
    }

    console.log(
      `  ${cat.padEnd(35)}${catStrs.join("")}${diffStr.padStart(10)}`,
    );
  }

  // Overall summary
  console.log("\n" + "─".repeat(90));
  console.log("  Overall:");
  for (const b of backends) {
    const s = b.report.summary;
    console.log(
      `    ${b.name.padEnd(15)} avg=${s.avgResponseMs.toFixed(1)}ms  success=${s.successfulCalls}/${s.totalCalls}  startup=${(b.startupMs / 1000).toFixed(1)}s`,
    );
  }
  console.log("═".repeat(90));
}

// --- Main ---

(async () => {
  console.log(`\n  ODATANO Backend Comparison`);
  console.log(`  Backends: ${BACKEND_CONFIGS.map((c) => c.name).join(", ")}`);
  console.log(`  Rounds: ${ROUNDS} per endpoint`);
  console.log(`  Port: ${PORT}\n`);

  // Validate API keys / URLs
  for (const config of BACKEND_CONFIGS) {
    const backends = config.env.BACKENDS.split(",");
    for (const backend of backends) {
      if (backend === "ogmios" && !config.env.OGMIOS_URL) {
        console.error(`  ERROR: OGMIOS_URL not set in .env — cannot benchmark ${config.name}`);
        process.exit(1);
      }
      if (backend === "blockfrost" && !config.env.BLOCKFROST_API_KEY) {
        console.error(`  ERROR: BLOCKFROST_API_KEY not set in .env — cannot benchmark ${config.name}`);
        process.exit(1);
      }
      if (backend === "koios" && !config.env.KOIOS_API_KEY) {
        console.error(`  ERROR: KOIOS_API_KEY not set in .env — cannot benchmark ${config.name}`);
        process.exit(1);
      }
    }
  }

  const compareResult: CompareResult = {
    timestamp: new Date().toISOString(),
    config: { rounds: ROUNDS, port: PORT },
    backends: [],
  };

  for (const config of BACKEND_CONFIGS) {
    console.log(`\n${"━".repeat(90)}`);
    console.log(`  Starting server with backend: ${config.name.toUpperCase()}`);
    console.log("━".repeat(90));

    // Clean database cache for fair comparison
    console.log("  Cleaning SQLite cache...");
    cleanDatabase();

    // Start server
    const proc = startServer(config);

    try {
      // Wait for server to be ready and measure startup time
      console.log(`  Waiting for server on port ${PORT}...`);
      const startupMs = await waitForServer();
      console.log(`  Server ready in ${(startupMs / 1000).toFixed(1)}s`);

      // Small delay to let server fully stabilize
      await new Promise((r) => setTimeout(r, 2000));

      // Run benchmark
      const report = await runBenchmark(BASE, ROUNDS);
      report.backend = config.name;
      report.startupMs = startupMs;

      compareResult.backends.push({ name: config.name, startupMs, report });
    } catch (err: any) {
      console.error(
        `  ERROR running benchmark for ${config.name}: ${err.message}`,
      );
      compareResult.backends.push({
        name: config.name,
        startupMs: -1,
        report: {
          timestamp: new Date().toISOString(),
          backend: config.name,
          config: { rounds: ROUNDS, baseUrl: BASE },
          results: [],
          summary: {
            totalEndpoints: 0,
            totalCalls: 0,
            successfulCalls: 0,
            failedCalls: 0,
            avgResponseMs: 0,
            slowest: { name: "", avgMs: 0 },
            fastest: { name: "", avgMs: 0 },
          },
        },
      });
    } finally {
      // Kill server
      console.log(`  Stopping ${config.name} server...`);
      await killServer(proc);
      // Wait for port to be released
      await new Promise((r) => setTimeout(r, 3000));
      console.log(`  Server stopped.`);
    }
  }

  // Print comparison
  if (compareResult.backends.length >= 2) {
    printComparison(compareResult);
  }

  // Save results
  fs.writeFileSync(OUTPUT, JSON.stringify(compareResult, null, 2));
  console.log(`\n  Results saved to: ${OUTPUT}\n`);
})();
