import type { Abi } from "viem";
import { encodePacked, formatEther, keccak256 } from "viem";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import agentCoinAbiJson from "./abi/AgentCoin.json";
import miningAgentAbiJson from "./abi/MiningAgent.json";
import { buildCpuC, buildMetal, findSourceDir, INSTALL_DIR } from "./build";
import { config } from "./config";
import { detectMiners, formatHashpower, rarityLabels, selectBestMiner } from "./detect";
import { classifyError } from "./errors";
import { txUrl } from "./explorer";
import type { GrindResult } from "./grinder";
import { grindNonceParallel } from "./grinder";
import { getGrindUrl, grindNonceHttp, isHttpGrinderConfigured } from "./grinder-http";
import { detectGrinders, grinderLabel, grindNonceNative, hasNativeGrinders } from "./grinder-native";
import type { GrinderInfo } from "./grinder-native";
import { normalizeSmhlChallenge, solveSmhlAlgorithmic, validateSmhlSolution } from "./smhl";
import * as ui from "./ui";
import { account as walletAccount, getEthBalance, publicClient, requireWallet } from "./wallet";

const agentCoinAbi = agentCoinAbiJson as Abi;
const miningAgentAbi = miningAgentAbiJson as Abi;

const MAX_CONSECUTIVE_FAILURES = 10;
const RETRY_DELAY_MS = 2_000;
const RETRY_JITTER_MS = 500;

const BASE_REWARD = 3n * 10n ** 18n;
const REWARD_DECAY_NUM = 90n;
const REWARD_DECAY_DEN = 100n;

function elapsedSeconds(start: [number, number]): number {
  const [seconds, nanoseconds] = process.hrtime(start);
  return seconds + nanoseconds / 1_000_000_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms / 1000}s`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    const err = new Error("Aborted");
    err.name = "AbortError";
    return Promise.reject(err);
  }

  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => {
      const err = new Error("Aborted");
      err.name = "AbortError";
      reject(err);
    }, { once: true });
  });
}

function retryDelayMs(): number {
  return RETRY_DELAY_MS + Math.random() * RETRY_JITTER_MS;
}

function estimateReward(totalMines: bigint, eraInterval: bigint, hashpower: bigint): bigint {
  const era = totalMines / eraInterval;
  let reward = BASE_REWARD;
  for (let i = 0n; i < era; i++) {
    reward = (reward * REWARD_DECAY_NUM) / REWARD_DECAY_DEN;
  }
  return (reward * hashpower) / 100n;
}

function formatBaseReward(era: bigint): string {
  let reward = 3;
  for (let i = 0n; i < era; i++) {
    reward *= 0.9;
  }
  return reward.toFixed(2);
}

async function waitForNextBlock(lastMineBlock: bigint): Promise<void> {
  const deadline = Date.now() + 60_000; // 60 seconds
  while (Date.now() < deadline) {
    const currentBlock = await publicClient.getBlockNumber();
    if (currentBlock > lastMineBlock) {
      return;
    }
    await sleep(500);
  }
  throw new Error("Timed out waiting for next block (60s)");
}

function estimateHashrate(grinderInfo: GrinderInfo, useNative: boolean, useHttpGrind: boolean): number {
  if (useHttpGrind) return 20_000_000_000; // 20 GH/s
  if (!useNative) return 25_000_000; // 25 MH/s (optimized JS)
  let rate = 0;
  if (grinderInfo.gpu) rate += 500_000_000; // 500 MH/s Metal
  if (grinderInfo.cpu) rate += 300_000_000; // 300 MH/s CPU-C
  if (grinderInfo.cuda) rate += 20_000_000_000; // 20 GH/s local CUDA
  if (grinderInfo.remoteGpu) rate += 20_000_000_000; // 20 GH/s remote CUDA
  return rate || 25_000_000;
}

function formatRate(rate: number): string {
  if (rate >= 1_000_000_000) return `${(rate / 1_000_000_000).toFixed(1)} GH/s`;
  if (rate >= 1_000_000) return `${(rate / 1_000_000).toFixed(0)} MH/s`;
  return `${(rate / 1_000).toFixed(0)} kH/s`;
}

function formatExpectedHashes(n: bigint): string {
  if (n >= 1_000_000_000n) return `${Number(n / 1_000_000_000n)}G`;
  if (n >= 1_000_000n) return `${Number(n / 1_000_000n)}M`;
  if (n >= 1_000n) return `${Number(n / 1_000n)}K`;
  return String(n);
}

function difficultyBits(target: bigint): number {
  if (target === 0n) return 256;
  let bits = 0;
  let t = (2n ** 256n - 1n) / target;
  while (t > 1n) { bits++; t >>= 1n; }
  return bits;
}

function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} min`;
  return `${(seconds / 3600).toFixed(1)} hr`;
}

async function readMiningChallenge(timeoutMs = 8_000): Promise<readonly [`0x${string}`, bigint, unknown]> {
  return withTimeout(
    publicClient.readContract({
      address: config.agentCoinAddress,
      abi: agentCoinAbi,
      functionName: "getMiningChallenge",
    }) as Promise<readonly [`0x${string}`, bigint, unknown]>,
    timeoutMs,
    "Mining challenge refresh",
  );
}

function readCliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function autoBuildGrinders(): boolean {
  const sourceDir = findSourceDir();
  if (!sourceDir) return false;

  console.log(`  ${ui.dim("Native grinders not found — auto-building (first mine only)...")}`);

  if (!existsSync(INSTALL_DIR)) {
    mkdirSync(INSTALL_DIR, { recursive: true });
  }

  let built = 0;

  const cpuResult = buildCpuC(sourceDir);
  if (cpuResult.success) {
    console.log(`    ${ui.green("CPU-C")} grinder built → ${ui.dim(cpuResult.path!)}`);
    built++;
  }

  if (process.platform === "darwin") {
    const metalResult = buildMetal(sourceDir);
    if (metalResult.success) {
      console.log(`    ${ui.green("Metal GPU")} grinder built → ${ui.dim(metalResult.path!)}`);
      built++;
    }
  }

  if (built > 0) {
    console.log(`  ${ui.green("Native grinders built!")} Re-detecting...`);
  } else {
    console.log(`  ${ui.dim("Auto-build failed (no C compiler). Install Xcode CLI tools or gcc, then run: apow build-grinders")}`);
  }
  return built > 0;
}

async function grindNonce(
  challengeNumber: `0x${string}`,
  target: bigint,
  minerAddress: `0x${string}`,
  onProgress?: (attempts: bigint, hashrate: number) => void,
): Promise<{ nonce: bigint; attempts: bigint; hashrate: number; elapsed: number }> {
  let nonce = 0n;
  let attempts = 0n;
  const start = process.hrtime();

  while (true) {
    const digest = BigInt(
      keccak256(
        encodePacked(["bytes32", "address", "uint256"], [challengeNumber, minerAddress, nonce]),
      ),
    );

    attempts += 1n;
    if (digest < target) {
      const elapsed = elapsedSeconds(start);
      const hashrate = elapsed > 0 ? Number(attempts) / elapsed : Number(attempts);
      return { nonce, attempts, hashrate, elapsed };
    }

    if (onProgress && attempts % 50_000n === 0n) {
      const elapsed = elapsedSeconds(start);
      const hashrate = elapsed > 0 ? Number(attempts) / elapsed : Number(attempts);
      onProgress(attempts, hashrate);
    }

    nonce += 1n;
  }
}

async function showStartupBanner(tokenId: bigint): Promise<void> {
  const { account } = requireWallet();

  const [ethBalance, totalMines, totalMinted, mineableSupply, eraInterval, hashpowerRaw, rarityRaw] =
    await Promise.all([
      getEthBalance(),
      publicClient.readContract({
        address: config.agentCoinAddress,
        abi: agentCoinAbi,
        functionName: "totalMines",
      }) as Promise<bigint>,
      publicClient.readContract({
        address: config.agentCoinAddress,
        abi: agentCoinAbi,
        functionName: "totalMinted",
      }) as Promise<bigint>,
      publicClient.readContract({
        address: config.agentCoinAddress,
        abi: agentCoinAbi,
        functionName: "MINEABLE_SUPPLY",
      }) as Promise<bigint>,
      publicClient.readContract({
        address: config.agentCoinAddress,
        abi: agentCoinAbi,
        functionName: "ERA_INTERVAL",
      }) as Promise<bigint>,
      publicClient.readContract({
        address: config.miningAgentAddress,
        abi: miningAgentAbi,
        functionName: "hashpower",
        args: [tokenId],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: config.miningAgentAddress,
        abi: miningAgentAbi,
        functionName: "rarity",
        args: [tokenId],
      }) as Promise<bigint>,
    ]);

  const rarity = Number(rarityRaw);
  const hashpower = Number(hashpowerRaw);
  const era = totalMines / eraInterval;
  const supplyPct = Number(totalMinted * 10000n / mineableSupply) / 100;

  console.log("");
  const version = readCliVersion();
  ui.banner([`AgentCoin Miner v${config.chainName === "baseSepolia" ? `${version}-testnet` : version}`]);
  ui.table([
    ["Wallet", `${account.address.slice(0, 6)}...${account.address.slice(-4)} (${Number(formatEther(ethBalance)).toFixed(4)} ETH)`],
    ["Miner", `#${tokenId} (${rarityLabels[rarity] ?? `Tier ${rarity}`}, ${formatHashpower(hashpower)})`],
    ["Network", config.chain.name],
    ["Era", `${era} — reward: ${formatBaseReward(era)} AGENT/mine`],
    ["Supply", `${supplyPct.toFixed(2)}% mined (${Number(formatEther(totalMinted)).toLocaleString()} / ${Number(formatEther(mineableSupply)).toLocaleString()} AGENT)`],
  ]);
  console.log("");
}

export async function startMining(tokenId: bigint): Promise<void> {
  const { account, walletClient } = requireWallet();
  let consecutiveFailures = 0;
  let mineCount = 0;
  let runningTotal = (await publicClient.readContract({
    address: config.agentCoinAddress,
    abi: agentCoinAbi,
    functionName: "tokenEarnings",
    args: [tokenId],
  })) as bigint;

  const useHttpGrind = isHttpGrinderConfigured();
  const x402OnlyMode = useHttpGrind && !config.allowLocalFallbackWithX402;
  // Detect native grinders only when they can actually participate.
  let grinderInfo: GrinderInfo = x402OnlyMode
    ? { gpu: null, cuda: null, cpu: null, remoteGpu: false, httpGrind: true }
    : detectGrinders();
  let useNative = !x402OnlyMode && config.grinderMode !== "js" && !!(grinderInfo.gpu || grinderInfo.cuda || grinderInfo.cpu || grinderInfo.remoteGpu);
  const grindUrl = getGrindUrl();

  // Auto-build native grinders on first mine if none detected
  if (!x402OnlyMode && !useNative && !useHttpGrind && config.grinderMode !== "js") {
    const built = autoBuildGrinders();
    if (built) {
      grinderInfo = detectGrinders();
      useNative = !!(grinderInfo.gpu || grinderInfo.cuda || grinderInfo.cpu || grinderInfo.remoteGpu);
    }
  }
  const useJsFallback = !useNative && (!useHttpGrind || config.allowLocalFallbackWithX402);

  // Build grinder label
  const labelParts: string[] = [];
  if (useNative) labelParts.push(grinderLabel(grinderInfo));
  if (useHttpGrind) {
    const host = new URL(grindUrl).hostname;
    labelParts.push(`x402 GPU (${host})`);
  }
  if (useJsFallback) labelParts.push(`JS (${config.minerThreads} threads)`);
  if (labelParts.length === 0) labelParts.push(`JS (${config.minerThreads} threads)`);
  let modeLabel = labelParts.join(" + ");

  await showStartupBanner(tokenId);
  console.log(`  Grinder: ${ui.bold(modeLabel)}`);

  // Difficulty-aware preflight gate
  const preflight = await readMiningChallenge();

  const preflightTarget = preflight[1];
  const expectedHashes = preflightTarget > 0n ? (2n ** 256n) / preflightTarget : 0n;
  const estHashrate = estimateHashrate(grinderInfo, useNative, useHttpGrind);
  const estimatedSeconds = expectedHashes > 0n ? Number(expectedHashes) / estHashrate : 0;
  const bits = difficultyBits(preflightTarget);
  const staleCheckSeconds = config.staleCheckIntervalMs / 1000;

  console.log(`  Difficulty: 2^${bits} (~${formatExpectedHashes(expectedHashes)} hashes expected)`);
  console.log(`  Est. speed: ${formatRate(estHashrate)} (${modeLabel})`);
  console.log(`  Est. time:  ~${formatTime(estimatedSeconds)} per mine`);

  if (estimatedSeconds > 300) {
    console.log("");
    ui.warn(`Your grinder (~${formatRate(estHashrate)}) is far too slow for current difficulty.`);
    console.log(`    Expected time per mine: ~${formatTime(estimatedSeconds)} (challenges go stale every ${staleCheckSeconds}s).`);
    console.log("");
    console.log(`    Fix options:`);
    console.log(`    1. Run ${ui.cyan("apow build-grinders")} for 100x faster local mining (~500 MH/s)`);
    console.log(`    2. Add USDC to wallet for x402 GPU mining (~20 GH/s, ~$0.006/mine)`);
    console.log(`    3. Set up VAST.ai CUDA for ~20 GH/s (see docs)`);
    console.log("");
    const proceed = await ui.confirm("Mining is strongly discouraged at this speed. Continue anyway?");
    if (!proceed) {
      console.log(`  ${ui.dim("Exiting. Build faster grinders and try again.")}`);
      return;
    }
  } else if (estimatedSeconds > staleCheckSeconds) {
    console.log("");
    ui.warn(`Your grinder (~${formatRate(estHashrate)}) is too slow for current difficulty.`);
    console.log(`    Expected time per mine: ~${formatTime(estimatedSeconds)} (challenges go stale every ${staleCheckSeconds}s).`);
    console.log("");
    console.log(`    Fix options:`);
    console.log(`    1. Run ${ui.cyan("apow build-grinders")} for 100x faster local mining (~500 MH/s)`);
    console.log(`    2. Add USDC to wallet for x402 GPU mining (~20 GH/s, ~$0.006/mine)`);
    console.log(`    3. Set up VAST.ai CUDA for ~20 GH/s (see docs)`);
    console.log("");
    const proceed = await ui.confirm("Continue anyway?");
    if (!proceed) {
      console.log(`  ${ui.dim("Exiting. Build faster grinders and try again.")}`);
      return;
    }
  }

  console.log("");

  while (true) {
    try {
      // Pre-flight ownership check
      const owner = (await publicClient.readContract({
        address: config.miningAgentAddress,
        abi: miningAgentAbi,
        functionName: "ownerOf",
        args: [tokenId],
      })) as `0x${string}`;

      if (owner.toLowerCase() !== account.address.toLowerCase()) {
        ui.error(`Miner #${tokenId} is owned by ${owner}, not your wallet.`);
        ui.hint("Check token ID or verify ownership on Basescan");
        return;
      }

      // Supply exhaustion pre-check
      const [totalMines, totalMinted, mineableSupply, eraInterval, hashpower] = await Promise.all([
        publicClient.readContract({
          address: config.agentCoinAddress,
          abi: agentCoinAbi,
          functionName: "totalMines",
        }) as Promise<bigint>,
        publicClient.readContract({
          address: config.agentCoinAddress,
          abi: agentCoinAbi,
          functionName: "totalMinted",
        }) as Promise<bigint>,
        publicClient.readContract({
          address: config.agentCoinAddress,
          abi: agentCoinAbi,
          functionName: "MINEABLE_SUPPLY",
        }) as Promise<bigint>,
        publicClient.readContract({
          address: config.agentCoinAddress,
          abi: agentCoinAbi,
          functionName: "ERA_INTERVAL",
        }) as Promise<bigint>,
        publicClient.readContract({
          address: config.miningAgentAddress,
          abi: miningAgentAbi,
          functionName: "hashpower",
          args: [tokenId],
        }) as Promise<bigint>,
      ]);

      const estimatedReward = estimateReward(totalMines, eraInterval, BigInt(hashpower));
      if (totalMinted + estimatedReward > mineableSupply) {
        ui.error(`Supply nearly exhausted. Remaining: ${formatEther(mineableSupply - totalMinted)} AGENT.`);
        return;
      }

      // Era transition alert
      const currentEra = totalMines / eraInterval;
      const minesUntilNextEra = eraInterval - (totalMines % eraInterval);
      if (minesUntilNextEra <= 10n) {
        ui.warn(`Era transition in ${minesUntilNextEra} mines! Reward will decrease.`);
      }

      mineCount++;
      console.log(`  ${ui.bold(`[Mine #${mineCount}]`)}`);

      const miningChallenge = await readMiningChallenge();

      let [challengeNumber, target] = [miningChallenge[0], miningChallenge[1]];
      const smhl = normalizeSmhlChallenge(miningChallenge[2]);

      // Solve SMHL algorithmically (sub-millisecond)
      const smhlStart = process.hrtime();
      let smhlSolution = solveSmhlAlgorithmic(smhl);
      const smhlIssues = validateSmhlSolution(smhlSolution, smhl);
      if (smhlIssues.length > 0) {
        throw new Error(`SMHL generation failed: ${smhlIssues.join(", ")}`);
      }
      const smhlElapsed = elapsedSeconds(smhlStart);
      console.log(`  ${ui.dim(`SMHL solved (${(smhlElapsed * 1000).toFixed(1)}ms)`)}`);


      // Grind nonce — x402 GPU is preferred for agent-first easy mode.
      // JS fallback only runs when explicitly allowed, to avoid burning
      // local CPU while a remote GPU grind is already in flight.
      // Abort and re-fetch challenge periodically to avoid grinding a dead
      // nonce after another miner wins the block. Configurable via
      // STALE_CHECK_INTERVAL env var (seconds, default 60).
      const staleCheckMs = config.staleCheckIntervalMs;
      let grind: GrindResult | null = null;
      let staleRestarts = 0;

      while (!grind) {
        const abortController = new AbortController();
        const nonceSpinner = ui.spinner(`Grinding nonce (${modeLabel})...`);

        // Background staleness checker
        let staleTimer: NodeJS.Timeout | null = null;
        let staleCheckStopped = false;
        let staleCheckInFlight = false;
        const stopStaleChecks = () => {
          staleCheckStopped = true;
          if (staleTimer) {
            clearTimeout(staleTimer);
            staleTimer = null;
          }
        };
        const scheduleStaleCheck = () => {
          if (staleCheckStopped || abortController.signal.aborted) return;
          staleTimer = setTimeout(async () => {
            if (staleCheckStopped || abortController.signal.aborted || staleCheckInFlight) {
              scheduleStaleCheck();
              return;
            }

            staleCheckInFlight = true;
            try {
              const fresh = await readMiningChallenge(Math.min(staleCheckMs, 5_000));
              if (fresh[0] !== challengeNumber && !abortController.signal.aborted) {
                staleRestarts++;
                nonceSpinner.stop(`Challenge changed — restarting grind (stale #${staleRestarts})`);
                abortController.abort();
                stopStaleChecks();
                return;
              }
            } catch {
              // RPC hiccup — don't abort, just skip this check
            } finally {
              staleCheckInFlight = false;
            }

            scheduleStaleCheck();
          }, staleCheckMs);
        };
        scheduleStaleCheck();

        try {
          // Race all available grinders — first valid nonce wins
          const grinders: Promise<GrindResult>[] = [];

          if (useNative) {
            grinders.push(
              Promise.race([
                grindNonceNative(challengeNumber, target, account.address, grinderInfo, abortController.signal),
                rejectOnAbort(abortController.signal),
              ])
                .catch((err) => {
                  if (abortController.signal.aborted) throw err;
                  const msg = err instanceof Error ? err.message : String(err);
                  if (msg.includes("No native grinders")) {
                    console.log(`  ${ui.dim("No native grinders found.")} ${ui.yellow("Tip:")} Run ${ui.cyan("apow build-grinders")} for 100x speedup`);
                  } else {
                    console.log(`  ${ui.dim(`Native grinder error: ${msg}`)}`);
                  }
                  throw err;
                }),
            );
          }

          if (useHttpGrind) {
            grinders.push(
              Promise.race([
                grindNonceHttp(challengeNumber, target, account.address, grindUrl, config.privateKey!, abortController.signal),
                rejectOnAbort(abortController.signal),
              ])
                .catch((err) => {
                  if (abortController.signal.aborted) throw err;
                  const msg = err instanceof Error ? err.message : String(err);
                  if (msg.includes("insufficient USDC")) {
                    console.log(`  ${ui.yellow("x402 GPU: insufficient USDC.")} Run: ${ui.cyan("apow wallet fund")}`);
                  } else if (msg.includes("simulation_failed")) {
                    console.log(`  ${ui.yellow("x402 GPU: EVM simulation failed.")} ${ui.dim("USDC approval or balance issue")}`);
                  } else if (msg.includes("402")) {
                    console.log(`  ${ui.yellow("x402 GPU payment failed.")} ${ui.dim(msg.slice(0, 120))}`);
                  } else {
                    console.log(`  ${ui.dim(`x402 GPU grinder error: ${msg}`)}`);
                  }
                  throw err;
                }),
            );
          }

          // JS fallback is disabled by default when x402 grinding is active.
          if (useJsFallback) {
            grinders.push(
              Promise.race([
                grindNonceParallel({
                  challengeNumber,
                  target,
                  minerAddress: account.address,
                  threads: config.minerThreads,
                  signal: abortController.signal,
                  onProgress: !useHttpGrind ? (attempts, hashrate) => {
                    const khs = (hashrate / 1000).toFixed(0);
                    nonceSpinner.update(`Grinding nonce (JS)... ${khs}k H/s (${attempts.toLocaleString()} attempts)`);
                  } : undefined,
                }),
                rejectOnAbort(abortController.signal),
              ]),
            );
          }

          try {
            grind = await Promise.any(grinders);
          } catch (err) {
            if (err instanceof AggregateError && err.errors.length > 0) {
              const firstNonAbort = err.errors.find((inner) => {
                if (!(inner instanceof Error)) return true;
                return inner.name !== "AbortError";
              });
              throw firstNonAbort ?? err.errors[0];
            }
            throw err;
          }

          const khs = grind.hashrate > 0 ? (grind.hashrate / 1000).toFixed(0) : "?";
          nonceSpinner.stop(`Nonce found (${grind.elapsed.toFixed(1)}s${grind.hashrate > 0 ? `, ${khs}k H/s` : ""})`);

          // Final stale check: a challenge can change between the periodic
          // poll and transaction submission, which would make the SMHL stale.
          const latestChallenge = await readMiningChallenge();
          if (latestChallenge[0] !== challengeNumber) {
            staleRestarts++;
            [challengeNumber, target] = [latestChallenge[0], latestChallenge[1]];
            const freshSmhl = normalizeSmhlChallenge(latestChallenge[2]);
            smhlSolution = solveSmhlAlgorithmic(freshSmhl);
            console.log(`  ${ui.dim("Challenge changed before submit — re-grinding fresh nonce...")}`);
            grind = null;
            continue;
          }
        } catch (err) {
          stopStaleChecks();
          if (abortController.signal.aborted) {
            // Challenge went stale — re-fetch and retry
            const freshChallenge = await readMiningChallenge();
            [challengeNumber, target] = [freshChallenge[0], freshChallenge[1]];
            const freshSmhl = normalizeSmhlChallenge(freshChallenge[2]);
            smhlSolution = solveSmhlAlgorithmic(freshSmhl);
            console.log(`  ${ui.dim("SMHL re-solved, grinding fresh challenge...")}`);
            if (staleRestarts >= 3 && staleRestarts % 3 === 0) {
              ui.warn(`Challenge has gone stale ${staleRestarts} times — grinder may be too slow for current difficulty.`);
              ui.warn(`Tip: increase STALE_CHECK_INTERVAL (current: ${staleCheckMs / 1000}s) or use a faster grinder.`);
            }
            grind = null; // loop again
            continue;
          }
          nonceSpinner.fail("Grinding nonce failed");
          throw err; // non-abort error — propagate
        } finally {
          stopStaleChecks();
        }
      }

      // Submit transaction with spinner
      const txSpinner = ui.spinner("Submitting transaction...");
      let txHash: `0x${string}` | undefined;
      let receipt: { status: string; blockNumber: bigint } | undefined;
      try {
        txHash = await walletClient.writeContract({
          address: config.agentCoinAddress,
          abi: agentCoinAbi,
          account,
          functionName: "mine",
          args: [grind.nonce, smhlSolution, tokenId],
        });
        txSpinner.update("Waiting for confirmation...");
        receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        if (receipt.status === "reverted") {
          throw new Error("Mine transaction reverted on-chain");
        }
        txSpinner.stop("Submitting transaction... confirmed");
      } catch (err) {
        txSpinner.fail("Submitting transaction failed");
        throw err;
      }

      // Fetch post-mine earnings with retry (public RPC may lag)
      let earnings = runningTotal;
      for (let retry = 0; retry < 5; retry++) {
        earnings = (await publicClient.readContract({
          address: config.agentCoinAddress,
          abi: agentCoinAbi,
          functionName: "tokenEarnings",
          args: [tokenId],
        })) as bigint;
        if (earnings > runningTotal) break;
        await new Promise((r) => setTimeout(r, 2000));
      }

      const delta = earnings - runningTotal;
      if (delta > 0n) {
        runningTotal = earnings;
        console.log(
          `  ${ui.green("+")} ${formatEther(delta)} AGENT | Total: ${formatEther(earnings)} AGENT | Tx: ${ui.dim(txUrl(txHash!))}`,
        );
      } else {
        console.log(
          `  ${ui.green("+")} ~${formatEther(estimatedReward)} AGENT ${ui.dim("(earnings sync pending)")} | Total: ${formatEther(runningTotal)} AGENT | Tx: ${ui.dim(txUrl(txHash!))}`,
        );
      }
      console.log("");

      // Wait for block advancement before next iteration
      await waitForNextBlock(receipt!.blockNumber);

      consecutiveFailures = 0;
    } catch (error) {
      const classified = classifyError(error);

      if (classified.category === "fatal" || classified.category === "setup") {
        ui.error(classified.userMessage);
        if (classified.recovery) ui.hint(classified.recovery);
        return;
      }

      if (classified.userMessage.includes("One mine per block")) {
        console.log(`  ${ui.dim("Waiting for next block...")}`);
        const lastMineBlock = (await publicClient.readContract({
          address: config.agentCoinAddress,
          abi: agentCoinAbi,
          functionName: "lastMineBlockNumber",
        })) as bigint;
        await waitForNextBlock(lastMineBlock);
        continue;
      }

      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        ui.error(`${MAX_CONSECUTIVE_FAILURES} consecutive failures. Last: ${classified.userMessage}`);
        return;
      }

      const delay = retryDelayMs();
      ui.error(`${classified.userMessage} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
      if (classified.recovery) ui.hint(classified.recovery);
      console.log(`  ${ui.dim(`Retrying in ${(delay / 1000).toFixed(1)}s...`)}`);
      await sleep(delay);
    }
  }
}
