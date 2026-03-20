import type { Abi } from "viem";
import { encodePacked, formatEther, keccak256 } from "viem";

import agentCoinAbiJson from "./abi/AgentCoin.json";
import miningAgentAbiJson from "./abi/MiningAgent.json";
import { config } from "./config";
import { detectMiners, formatHashpower, selectBestMiner } from "./detect";
import { classifyError } from "./errors";
import { txUrl } from "./explorer";
import { normalizeSmhlChallenge, solveSmhlChallenge } from "./smhl";
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

  const rarityLabels = ["Common", "Uncommon", "Rare", "Epic", "Mythic"];
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

  await showStartupBanner(tokenId);

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

      const [challengeNumber, target, rawSmhl] = miningChallenge;
      const smhl = normalizeSmhlChallenge(rawSmhl);

      // Solve SMHL with spinner
      const smhlSpinner = ui.spinner("Solving SMHL challenge...");
      const smhlStart = process.hrtime();
      const smhlSolution = await solveSmhlChallenge(smhl, (attempt) => {
        smhlSpinner.update(`Solving SMHL challenge... attempt ${attempt}/3`);
      });
      const smhlElapsed = elapsedSeconds(smhlStart);
      smhlSpinner.stop(`Solving SMHL challenge... done (${smhlElapsed.toFixed(1)}s)`);

      // Grind nonce with spinner
      const nonceSpinner = ui.spinner("Grinding nonce...");
      const grind = await grindNonce(challengeNumber, target, account.address, (attempts, hashrate) => {
        const khs = (hashrate / 1000).toFixed(0);
        nonceSpinner.update(`Grinding nonce... ${khs}k H/s (${attempts.toLocaleString()} attempts)`);
      });
      const khs = (grind.hashrate / 1000).toFixed(0);
      nonceSpinner.stop(`Grinding nonce... done (${grind.elapsed.toFixed(1)}s, ${khs}k H/s)`);

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

      // Fetch post-mine stats
      const [tokenMineCount, earnings] = await Promise.all([
        publicClient.readContract({
          address: config.agentCoinAddress,
          abi: agentCoinAbi,
          functionName: "tokenMineCount",
          args: [tokenId],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: config.agentCoinAddress,
          abi: agentCoinAbi,
          functionName: "tokenEarnings",
          args: [tokenId],
        }) as Promise<bigint>,
      ]);

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
