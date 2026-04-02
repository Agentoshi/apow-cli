import type { Abi } from "viem";
import { encodePacked, formatEther, keccak256 } from "viem";

import agentCoinAbiJson from "./abi/AgentCoin.json";
import miningAgentAbiJson from "./abi/MiningAgent.json";
import { config } from "./config";
import { detectMiners, formatHashpower, rarityLabels, selectBestMiner } from "./detect";
import { classifyError } from "./errors";
import { txUrl } from "./explorer";
import type { GrindResult } from "./grinder";
import { grindNonceParallel } from "./grinder";
import { getGrindUrl, grindNonceHttp, isHttpGrinderConfigured } from "./grinder-http";
import { detectGrinders, grinderLabel, grindNonceNative, hasNativeGrinders } from "./grinder-native";
import { normalizeSmhlChallenge, solveSmhlAlgorithmic, validateSmhlSolution } from "./smhl";
import * as ui from "./ui";
import { account as walletAccount, getEthBalance, publicClient, requireWallet } from "./wallet";

const agentCoinAbi = agentCoinAbiJson as Abi;
const miningAgentAbi = miningAgentAbiJson as Abi;

const MAX_CONSECUTIVE_FAILURES = 10;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;

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

function backoffMs(failures: number): number {
  const base = Math.min(BASE_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
  const jitter = Math.random() * base * 0.3;
  return base + jitter;
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
  ui.banner([`AgentCoin Miner v${config.chainName === "baseSepolia" ? "0.1.0-testnet" : "0.1.0"}`]);
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
  let runningTotal = 0n;

  // Detect native grinders once at startup
  const grinderInfo = detectGrinders();
  const useNative = config.grinderMode !== "js" && hasNativeGrinders(grinderInfo);
  const useHttpGrind = isHttpGrinderConfigured();
  const grindUrl = getGrindUrl();

  // Build grinder label
  const labelParts: string[] = [];
  if (useNative) labelParts.push(grinderLabel(grinderInfo));
  if (useHttpGrind) {
    const host = new URL(grindUrl).hostname;
    labelParts.push(`x402 GPU (${host})`);
  }
  if (labelParts.length === 0) labelParts.push(`JS (${config.minerThreads} threads)`);
  const modeLabel = labelParts.join(" + ");

  await showStartupBanner(tokenId);
  console.log(`  Grinder: ${ui.bold(modeLabel)}`);

  // Hint for JS-only miners without x402 grind
  if (!useNative && !useHttpGrind) {
    console.log(`  ${ui.dim("Tip: Add USE_X402_GRIND=true for 10-100x faster mining (~$0.006/grind).")}`);
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

      const miningChallenge = (await publicClient.readContract({
        address: config.agentCoinAddress,
        abi: agentCoinAbi,
        functionName: "getMiningChallenge",
      })) as readonly [`0x${string}`, bigint, unknown];

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


      // Grind nonce — native GPU/CPU if available, JS fallback
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
        const staleTimer = setInterval(async () => {
          try {
            const fresh = (await publicClient.readContract({
              address: config.agentCoinAddress,
              abi: agentCoinAbi,
              functionName: "getMiningChallenge",
            })) as readonly [`0x${string}`, bigint, unknown];
            if (fresh[0] !== challengeNumber) {
              staleRestarts++;
              nonceSpinner.stop(`Challenge changed — restarting grind (stale #${staleRestarts})`);
              abortController.abort();
            }
          } catch {
            // RPC hiccup — don't abort, just skip this check
          }
        }, staleCheckMs);

        try {
          // Race all available grinders — first valid nonce wins
          const grinders: Promise<GrindResult>[] = [];

          if (useNative) {
            grinders.push(
              grindNonceNative(challengeNumber, target, account.address, grinderInfo, abortController.signal)
                .catch((err) => {
                  if (abortController.signal.aborted) throw err;
                  // Native failed but don't abort the race — others may still win
                  console.log(`  ${ui.dim(`Native grinder error: ${err instanceof Error ? err.message : String(err)}`)}`);
                  return new Promise<GrindResult>(() => {}); // hang forever (race will resolve via another grinder)
                }),
            );
          }

          if (useHttpGrind) {
            grinders.push(
              grindNonceHttp(challengeNumber, target, account.address, grindUrl, config.privateKey!, abortController.signal)
                .catch((err) => {
                  if (abortController.signal.aborted) throw err;
                  // Log x402 errors visibly — payment failures, timeouts, etc.
                  console.log(`  ${ui.dim(`x402 GPU grinder error: ${err instanceof Error ? err.message : String(err)}`)}`);
                  return new Promise<GrindResult>(() => {});
                }),
            );
          }

          // JS fallback always runs (it's the baseline)
          grinders.push(
            grindNonceParallel({
              challengeNumber,
              target,
              minerAddress: account.address,
              threads: config.minerThreads,
              signal: abortController.signal,
              onProgress: !useNative && !useHttpGrind ? (attempts, hashrate) => {
                const khs = (hashrate / 1000).toFixed(0);
                nonceSpinner.update(`Grinding nonce (JS)... ${khs}k H/s (${attempts.toLocaleString()} attempts)`);
              } : undefined,
            }),
          );

          grind = await Promise.race(grinders);

          clearInterval(staleTimer);
          const khs = grind.hashrate > 0 ? (grind.hashrate / 1000).toFixed(0) : "?";
          nonceSpinner.stop(`Nonce found (${grind.elapsed.toFixed(1)}s${grind.hashrate > 0 ? `, ${khs}k H/s` : ""})`);
        } catch (err) {
          clearInterval(staleTimer);
          if (abortController.signal.aborted) {
            // Challenge went stale — re-fetch and retry
            const freshChallenge = (await publicClient.readContract({
              address: config.agentCoinAddress,
              abi: agentCoinAbi,
              functionName: "getMiningChallenge",
            })) as readonly [`0x${string}`, bigint, unknown];
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
          throw err; // non-abort error — propagate
        }
      }

      // Submit transaction with spinner
      const txSpinner = ui.spinner("Submitting transaction...");
      const txHash = await walletClient.writeContract({
        address: config.agentCoinAddress,
        abi: agentCoinAbi,
        account,
        functionName: "mine",
        args: [grind.nonce, smhlSolution, tokenId],
      });
      txSpinner.update("Waiting for confirmation...");
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status === "reverted") {
        throw new Error("Mine transaction reverted on-chain");
      }
      txSpinner.stop("Submitting transaction... confirmed");

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
      runningTotal = earnings;

      console.log(
        `  ${ui.green("+")} ${formatEther(delta)} AGENT | Total: ${formatEther(earnings)} AGENT | Tx: ${ui.dim(txUrl(txHash))}`,
      );
      console.log("");

      // Wait for block advancement before next iteration
      const lastMineBlock = (await publicClient.readContract({
        address: config.agentCoinAddress,
        abi: agentCoinAbi,
        functionName: "lastMineBlockNumber",
      })) as bigint;
      await waitForNextBlock(lastMineBlock);

      consecutiveFailures = 0;
    } catch (error) {
      const classified = classifyError(error);

      if (classified.category === "fatal") {
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

      const delay = backoffMs(consecutiveFailures);
      ui.error(`${classified.userMessage} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
      if (classified.recovery) ui.hint(classified.recovery);
      console.log(`  ${ui.dim(`Retrying in ${(delay / 1000).toFixed(1)}s...`)}`);
      await sleep(delay);
    }
  }
}
