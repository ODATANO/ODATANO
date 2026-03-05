
/**
 * ODATANO Performance Benchmark
 *
 * Runs a series of OData calls against a running server, measures response times,
 * and writes results to scripts/perf-results.json.
 *
 * Usage:
 *   1. Start server: cds watch
 *   2. Run: npx tsx scripts/perf-benchmark.ts
 *
 * Options:
 *   --rounds <n>    Number of rounds per endpoint (default: 3)
 *   --base <url>    Base URL (default: http://localhost:4004)
 *   --output <file> Output file (default: scripts/perf-results.json)
 */

import axios, { AxiosError } from 'axios';
import * as fs from 'fs';
import * as path from 'path';

// --- Types (exported for perf-compare.ts) ---

export interface Endpoint {
  name: string;
  method: 'GET' | 'POST';
  url: string;
  data?: Record<string, unknown>;
  category: 'network' | 'block' | 'epoch' | 'pool' | 'address' | 'transaction' | 'account' | 'drep' | 'metadata' | 'tx-build' | 'signing';
}

export interface CallResult {
  round: number;
  status: number;
  durationMs: number;
  dataSize: number;
  error?: string;
}

export interface EndpointResult {
  name: string;
  category: string;
  method: string;
  rounds: CallResult[];
  stats: {
    min: number;
    max: number;
    avg: number;
    median: number;
    p95: number;
    coldStart: number;
    warmAvg: number;
  };
}

export interface BenchmarkReport {
  timestamp: string;
  backend?: string;
  startupMs?: number;
  config: { rounds: number; baseUrl: string };
  results: EndpointResult[];
  summary: {
    totalEndpoints: number;
    totalCalls: number;
    successfulCalls: number;
    failedCalls: number;
    avgResponseMs: number;
    slowest: { name: string; avgMs: number };
    fastest: { name: string; avgMs: number };
  };
}

// --- Test fixtures (Preview network) ---

const ADDR = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
const TX_HASH = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';
const BLOCK_HASH = 'cb082e3e77a7d8cf56baaba5cbe8843d63b53fa41074557ed29e0dbfe7daab39';
const POOL_ID = 'pool1knap9hldvhww0fjqew26sxkfjpj3c8tp8uuj7j3729lzqn9x70r';
const STAKE_ADDR = 'stake_test1urqntq4wexjylnrdnp97qq79qkxxvrsa9lcnwr7ckjd6w0cr04y4p';
const EPOCH = 500;
const DREP_ID = 'drep1y2ldnl4ugmhx873hpw7x23rvqe7krtwvgmvqjn3hy62xv6c8ashc0';
const METADATA_TX = '95edd3f70ac85d6445fd5d719a66955edf3eda78c0c365004f8c28b3e9e48bb1';

// Transaction & Signing fixtures
const ADDR_WITH_FUNDS = 'addr_test1qrgfq5jeznaehnf4zs02laas2juuuyzlz48tkue50luuws2nrznmesueg7drstsqaaenq6qpcnvqvn0kessd9fw2wxys6tv622';
const ADDR_PLUTUS = 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp';
const ADDR_RECIPIENT = 'addr_test1vr8nl4u0u6fmtfnawx2rxfz95dy7m46t6dhzdftp2uha87syeufdg';
const POLICY_ID = 'def68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088ea';
const ASSET_NAME_HEX = '546f6b656e4d';
const ASSET_UNIT = `${POLICY_ID}${ASSET_NAME_HEX}`;
const PLUTUS_SCRIPT = '585401010029800aba2aba1aab9eaab9dab9a4888896600264653001300600198031803800cc0180092225980099b8748000c01cdd500144c9289bae30093008375400516401830060013003375400d149a26cac8009';
const SPEND_SCRIPT = '587601010029800aba2aba1aab9eaab9dab9a48888966002646465300130053754003300700398038012444b30013370e9000001c4c9289bae300a3009375400915980099b874800800e2646644944c02c004c02cc030004c024dd5002459007200e18031803800980300098019baa0068a4d13656400401';
const SIGNER_KEY_HASH = 'f0ff0a3d030cf34157f740c0584dc0662d4d96b6b6e1f69f02e637b9';
const SCRIPT_UTXO_TX = '31dcba9c04443fd067e127d551c159511c1751bb645bdb8efd5094c7589cb272';

// CAP mock auth: Basic auth with any user (e.g. alice), no password required
const AUTH_HEADER = 'Basic ' + Buffer.from('alice:').toString('base64');

// --- Shared helpers (exported for perf-compare.ts) ---

export function buildEndpoints(base: string): Endpoint[] {
  const ODATA = `${base}/odata/v4/cardano-odata`;
  const TX = `${base}/odata/v4/cardano-transaction`;
  const SIGN = `${base}/odata/v4/cardano-sign`;

  return [
    // --- Actions ---

    // Network
    { name: 'GetNetworkInformation', method: 'POST', url: `${ODATA}/GetNetworkInformation`, data: {}, category: 'network' },
    { name: 'GetLatestBlock', method: 'POST', url: `${ODATA}/GetLatestBlock`, data: {}, category: 'block' },
    { name: 'GetLatestEpoch', method: 'POST', url: `${ODATA}/GetLatestEpoch`, data: {}, category: 'epoch' },
    { name: 'GetLedgerProtocolParameters', method: 'POST', url: `${ODATA}/GetLedgerProtocolParameters`, data: {}, category: 'network' },

    // Blocks
    { name: 'GetBlockByHash', method: 'POST', url: `${ODATA}/GetBlockByHash`, data: { hash: BLOCK_HASH }, category: 'block' },

    // Epochs
    { name: 'GetEpochByNumber', method: 'POST', url: `${ODATA}/GetEpochByNumber`, data: { epochNumber: EPOCH }, category: 'epoch' },

    // Pools
    { name: 'GetPoolById', method: 'POST', url: `${ODATA}/GetPoolById`, data: { poolId: POOL_ID }, category: 'pool' },

    // DReps
    { name: 'GetDrepById', method: 'POST', url: `${ODATA}/GetDrepById`, data: { drepId: DREP_ID }, category: 'drep' },

    // Accounts
    { name: 'GetAccountByStakeAddress', method: 'POST', url: `${ODATA}/GetAccountByStakeAddress`, data: { stakeAddress: STAKE_ADDR }, category: 'account' },

    // Transactions
    { name: 'GetTransactionByHash', method: 'POST', url: `${ODATA}/GetTransactionByHash`, data: { hash: TX_HASH }, category: 'transaction' },
    { name: 'GetMetadataByTxHash', method: 'POST', url: `${ODATA}/GetMetadataByTxHash`, data: { tx_hash: METADATA_TX }, category: 'metadata' },

    // Address (these hit blockchain backends)
    { name: 'GetAddressByBech32', method: 'POST', url: `${ODATA}/GetAddressByBech32`, data: { address: ADDR }, category: 'address' },
    { name: 'GetUTxOsByAddress', method: 'POST', url: `${ODATA}/GetUTxOsByAddress`, data: { address: ADDR }, category: 'address' },
    { name: 'GetAssetsByAddress', method: 'POST', url: `${ODATA}/GetAssetsByAddress`, data: { address: ADDR }, category: 'address' },
    { name: 'GetLatestTransactionsByAddress', method: 'POST', url: `${ODATA}/GetLatestTransactionsByAddress`, data: { address: ADDR }, category: 'address' },

    // --- Entity GET reads (cached) ---

    { name: 'GET Blocks(hash)', method: 'GET', url: `${ODATA}/Blocks('${BLOCK_HASH}')`, category: 'block' },
    { name: 'GET Epochs(number)', method: 'GET', url: `${ODATA}/Epochs(${EPOCH})`, category: 'epoch' },
    { name: 'GET Pools(id)', method: 'GET', url: `${ODATA}/Pools('${POOL_ID}')`, category: 'pool' },
    { name: 'GET Dreps(id)', method: 'GET', url: `${ODATA}/Dreps('${DREP_ID}')`, category: 'drep' },
    { name: 'GET Accounts(stake)', method: 'GET', url: `${ODATA}/Accounts('${STAKE_ADDR}')`, category: 'account' },
    { name: 'GET Transactions(hash)', method: 'GET', url: `${ODATA}/Transactions('${TX_HASH}')`, category: 'transaction' },
    { name: 'GET Addresses(bech32)', method: 'GET', url: `${ODATA}/Addresses('${ADDR}')`, category: 'address' },
    { name: 'GET NetworkInformation', method: 'GET', url: `${ODATA}/NetworkInformation`, category: 'network' },

    // --- Transaction Building Actions ---

    { name: 'BuildSimpleAdaTransaction', method: 'POST', url: `${TX}/BuildSimpleAdaTransaction`, data: {
      senderAddress: ADDR_WITH_FUNDS,
      recipientAddress: ADDR_RECIPIENT,
      lovelaceAmount: '5000000',
      changeAddress: ADDR_WITH_FUNDS,
    }, category: 'tx-build' },

    { name: 'BuildTxWithMetadata', method: 'POST', url: `${TX}/BuildTransactionWithMetadata`, data: {
      senderAddress: ADDR_WITH_FUNDS,
      recipientAddress: ADDR_RECIPIENT,
      lovelaceAmount: '5000000',
      changeAddress: ADDR_WITH_FUNDS,
      metadataJson: JSON.stringify({ '674': { msg: ['ODATANO', 'perf', 'test'] } }),
    }, category: 'tx-build' },

    { name: 'BuildMultiAssetTx', method: 'POST', url: `${TX}/BuildMultiAssetTransaction`, data: {
      senderAddress: ADDR_WITH_FUNDS,
      recipientAddress: ADDR_RECIPIENT,
      lovelaceAmount: '5000000',
      assetsJson: JSON.stringify([{ unit: ASSET_UNIT, quantity: '100' }]),
      changeAddress: ADDR_WITH_FUNDS,
    }, category: 'tx-build' },

    { name: 'BuildMultiAssetTx+Datum', method: 'POST', url: `${TX}/BuildMultiAssetTransaction`, data: {
      senderAddress: ADDR_WITH_FUNDS,
      recipientAddress: ADDR_RECIPIENT,
      lovelaceAmount: '5000000',
      assetsJson: JSON.stringify([{ unit: ASSET_UNIT, quantity: '100' }]),
      changeAddress: ADDR_WITH_FUNDS,
      outputDatumJson: JSON.stringify({ constructor: 0, fields: [{ int: 42 }] }),
    }, category: 'tx-build' },

    // SetCollateral BEFORE Plutus builds (Plutus transactions need collateral)
    { name: 'SetCollateral(PLUTUS)', method: 'POST', url: `${TX}/SetCollateral`, data: {
      address: ADDR_PLUTUS,
    }, category: 'tx-build' },

    { name: 'SetCollateral(FUNDS)', method: 'POST', url: `${TX}/SetCollateral`, data: {
      address: ADDR_WITH_FUNDS,
    }, category: 'tx-build' },

    { name: 'BuildMintTransaction', method: 'POST', url: `${TX}/BuildMintTransaction`, data: {
      senderAddress: ADDR_PLUTUS,
      recipientAddress: ADDR_PLUTUS,
      lovelaceAmount: '2000000',
      mintActionsJson: JSON.stringify([{ assetUnit: ASSET_UNIT, quantity: '1000' }]),
      mintingPolicyScript: PLUTUS_SCRIPT,
      changeAddress: ADDR_PLUTUS,
    }, category: 'tx-build' },

    { name: 'BuildMintTx+RequiredSigners', method: 'POST', url: `${TX}/BuildMintTransaction`, data: {
      senderAddress: ADDR_PLUTUS,
      recipientAddress: ADDR_PLUTUS,
      lovelaceAmount: '2000000',
      mintActionsJson: JSON.stringify([{ assetUnit: ASSET_UNIT, quantity: '1' }]),
      mintingPolicyScript: PLUTUS_SCRIPT,
      changeAddress: ADDR_PLUTUS,
      requiredSignersJson: JSON.stringify([SIGNER_KEY_HASH]),
    }, category: 'tx-build' },

    // NOTE: BuildPlutusSpendTransaction requires an active UTxO at the script address.
    // Run `npx tsx scripts/lock-ada-at-script-preview.ts` first to create one.
    { name: 'BuildPlutusSpendTx', method: 'POST', url: `${TX}/BuildPlutusSpendTransaction`, data: {
      senderAddress: ADDR_PLUTUS,
      recipientAddress: ADDR_PLUTUS,
      lovelaceAmount: '2000000',
      validatorScript: SPEND_SCRIPT,
      scriptTxHash: SCRIPT_UTXO_TX,
      scriptOutputIndex: 0,
      redeemerJson: JSON.stringify({ constructor: 0, fields: [] }),
      datumJson: JSON.stringify({ constructor: 0, fields: [] }),
      changeAddress: ADDR_PLUTUS,
    }, category: 'tx-build' },

    { name: 'GetTxBuildsByAddress', method: 'POST', url: `${TX}/GetTransactionBuildsByAddress`, data: {
      address: ADDR_WITH_FUNDS,
    }, category: 'tx-build' },

    // --- Signing Service Actions ---

    { name: 'GetHsmStatus', method: 'POST', url: `${SIGN}/GetHsmStatus`, data: {}, category: 'signing' },

    { name: 'GetSigningReqsByAddress', method: 'POST', url: `${SIGN}/GetSigningRequestsByAddress`, data: {
      address: ADDR_WITH_FUNDS,
    }, category: 'signing' },
  ];
}

export function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export async function callEndpoint(ep: Endpoint): Promise<{ status: number; durationMs: number; dataSize: number; error?: string; responseData?: Record<string, unknown> }> {
  const start = performance.now();
  try {
    const config = {
      timeout: 120_000,
      headers: { 'Content-Type': 'application/json', 'Authorization': AUTH_HEADER },
    };
    const res = ep.method === 'POST'
      ? await axios.post(ep.url, ep.data, config)
      : await axios.get(ep.url, config);
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    // Treat 409 as success (e.g. SetCollateral when collateral already exists)
    return { status: res.status, durationMs, dataSize: JSON.stringify(res.data).length, responseData: res.data };
  } catch (err: unknown) {
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    const axErr = err as AxiosError;
    const status = axErr.response?.status ?? 0;
    // Treat 409 as success (e.g. SetCollateral when collateral already exists)
    if (status === 409) {
      return { status, durationMs, dataSize: 0 };
    }
    return {
      status,
      durationMs,
      dataSize: 0,
      error: `${status || 'NETWORK'}: ${axErr.message}`,
    };
  }
}

export function computeStats(rounds: CallResult[]): EndpointResult['stats'] {
  const durations = rounds.map(r => r.durationMs);
  if (durations.length === 0) return { min: 0, max: 0, avg: 0, median: 0, p95: 0, coldStart: 0, warmAvg: 0 };

  const sorted = [...durations].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const coldStart = durations[0];
  const warm = durations.slice(1);
  const warmAvg = warm.length > 0 ? Math.round((warm.reduce((a, b) => a + b, 0) / warm.length) * 100) / 100 : coldStart;

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round((sum / sorted.length) * 100) / 100,
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    coldStart,
    warmAvg,
  };
}

/**
 * Run the full benchmark suite against a running server.
 * Returns a BenchmarkReport with all results.
 */
export async function runBenchmark(base: string, rounds: number, opts?: { silent?: boolean }): Promise<BenchmarkReport> {
  const silent = opts?.silent ?? false;
  const endpoints = buildEndpoints(base);
  const SIGN = `${base}/odata/v4/cardano-sign`;
  const TX = `${base}/odata/v4/cardano-transaction`;

  if (!silent) {
    console.log(`\n  ODATANO Performance Benchmark`);
    console.log(`  ${rounds} rounds x ${endpoints.length} endpoints = ${rounds * endpoints.length} calls`);
    console.log(`  Server: ${base}\n`);
    console.log('─'.repeat(80));
  }

  const results: EndpointResult[] = [];
  let lastBuildId: string | undefined;

  for (const ep of endpoints) {
    const epRounds: CallResult[] = [];
    if (!silent) process.stdout.write(`  ${ep.name.padEnd(40)}`);

    for (let r = 1; r <= rounds; r++) {
      const res = await callEndpoint(ep);
      epRounds.push({ round: r, ...res });

      if (!silent) process.stdout.write(res.error ? 'x' : '.');

      if (ep.name === 'BuildSimpleAdaTransaction' && !lastBuildId && !res.error && res.responseData) {
        lastBuildId = res.responseData.id as string;
      }
    }

    const stats = computeStats(epRounds);
    results.push({ name: ep.name, category: ep.category, method: ep.method, rounds: epRounds, stats });

    if (!silent) {
      const errCount = epRounds.filter(r => !!r.error).length;
      const errSuffix = errCount > 0 ? `  [${errCount}/${epRounds.length} failed: ${epRounds.find(r => r.error)?.status}]` : '';
      console.log(`  avg=${stats.avg}ms  cold=${stats.coldStart}ms  warm=${stats.warmAvg}ms${errSuffix}`);
    }
  }

  // --- Chained Signing Flow ---
  if (!silent) {
    console.log('─'.repeat(80));
    console.log('  Chained signing flow (depends on BuildSimpleAdaTransaction result):');
  }

  if (lastBuildId) {
    const chainedEndpoints: Endpoint[] = [
      { name: 'GetBuildDetails', method: 'POST', url: `${TX}/GetBuildDetails`, data: { buildId: lastBuildId }, category: 'tx-build' },
      { name: 'CreateSigningRequest', method: 'POST', url: `${SIGN}/CreateSigningRequest`, data: { buildId: lastBuildId }, category: 'signing' },
    ];

    let signingRequestId: string | undefined;

    for (const ep of chainedEndpoints) {
      const epRounds: CallResult[] = [];
      if (!silent) process.stdout.write(`  ${ep.name.padEnd(40)}`);

      const res = await callEndpoint(ep);
      epRounds.push({ round: 1, ...res });

      if (ep.name === 'CreateSigningRequest' && !res.error && res.responseData) {
        signingRequestId = res.responseData.id as string;
      }

      if (!silent) process.stdout.write(res.error ? 'x' : '.');

      const stats = computeStats(epRounds);
      results.push({ name: ep.name, category: ep.category, method: ep.method, rounds: epRounds, stats });
      if (!silent) console.log(`  avg=${stats.avg}ms`);
    }

    if (signingRequestId) {
      const ep: Endpoint = { name: 'GetSigningRequest', method: 'POST', url: `${SIGN}/GetSigningRequest`, data: { signingRequestId }, category: 'signing' };
      const epRounds: CallResult[] = [];
      if (!silent) process.stdout.write(`  ${ep.name.padEnd(40)}`);
      const res = await callEndpoint(ep);
      epRounds.push({ round: 1, ...res });
      if (!silent) process.stdout.write(res.error ? 'x' : '.');
      const stats = computeStats(epRounds);
      results.push({ name: ep.name, category: ep.category, method: ep.method, rounds: epRounds, stats });
      if (!silent) console.log(`  avg=${stats.avg}ms`);
    } else if (!silent) {
      console.log('  GetSigningRequest                       skipped (no signing request ID)');
    }
  } else if (!silent) {
    console.log('  skipped — no build ID captured from BuildSimpleAdaTransaction');
  }

  // Build report
  const allDurations = results.flatMap(r => r.rounds.map(c => c.durationMs));
  const successCount = results.reduce((s, r) => s + r.rounds.filter(c => !c.error).length, 0);
  const failCount = results.reduce((s, r) => s + r.rounds.filter(c => !!c.error).length, 0);
  const avgAll = allDurations.length > 0 ? Math.round((allDurations.reduce((a, b) => a + b, 0) / allDurations.length) * 100) / 100 : 0;

  const successResults = results.filter(r => r.rounds.some(c => !c.error));
  const byAvg = [...successResults].sort((a, b) => a.stats.avg - b.stats.avg);
  const fastest = byAvg[0] ?? results[0];
  const slowest = byAvg[byAvg.length - 1] ?? results[results.length - 1];

  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    config: { rounds, baseUrl: base },
    results,
    summary: {
      totalEndpoints: results.length,
      totalCalls: results.reduce((s, r) => s + r.rounds.length, 0),
      successfulCalls: successCount,
      failedCalls: failCount,
      avgResponseMs: avgAll,
      slowest: { name: slowest.name, avgMs: slowest.stats.avg },
      fastest: { name: fastest.name, avgMs: fastest.stats.avg },
    },
  };

  if (!silent) {
    console.log('─'.repeat(80));
    console.log(`\n  Summary:`);
    const totalCalls = results.reduce((s, r) => s + r.rounds.length, 0);
    console.log(`    Calls: ${successCount}/${totalCalls} successful`);
    console.log(`    Avg response: ${avgAll}ms`);
    console.log(`    Fastest: ${fastest.name} (${fastest.stats.avg}ms avg)`);
    console.log(`    Slowest: ${slowest.name} (${slowest.stats.avg}ms avg)`);

    console.log(`\n  Cold Start vs Warm (avg across all endpoints):`);
    const avgCold = Math.round((results.reduce((s, r) => s + r.stats.coldStart, 0) / results.length) * 100) / 100;
    const avgWarm = Math.round((results.reduce((s, r) => s + r.stats.warmAvg, 0) / results.length) * 100) / 100;
    const cacheSpeedup = avgCold > 0 ? Math.round(((avgCold - avgWarm) / avgCold) * 100) : 0;
    console.log(`    Cold: ${avgCold}ms  →  Warm: ${avgWarm}ms  (${cacheSpeedup}% faster with cache)`);

    console.log(`\n  By Category (avg ms):`);
    const categories = [...new Set(results.map(r => r.category))];
    for (const cat of categories) {
      const catResults = results.filter(r => r.category === cat);
      const catAvg = Math.round((catResults.reduce((s, r) => s + r.stats.avg, 0) / catResults.length) * 100) / 100;
      console.log(`    ${cat.padEnd(15)} ${catAvg}ms`);
    }
  }

  return report;
}

// --- CLI entry point ---

if (require.main === module) {
  const args = process.argv.slice(2);
  function getArg(name: string, fallback: string): string {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  }

  const ROUNDS = parseInt(getArg('rounds', '3'), 10);
  const BASE = getArg('base', 'http://localhost:4004');
  const OUTPUT = getArg('output', path.join(__dirname, 'perf-results.json'));

  (async () => {
    const report = await runBenchmark(BASE, ROUNDS);

    fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
    console.log(`\n  Results saved to: ${OUTPUT}\n`);
  })();
}
