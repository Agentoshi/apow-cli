import type { Abi } from "viem";
import { formatEther } from "viem";

import agentCoinAbiJson from "./abi/AgentCoin.json";
import miningAgentAbiJson from "./abi/MiningAgent.json";
import { config } from "./config";
import { formatHashpower } from "./detect";
import { tokenUrl } from "./explorer";
import * as ui from "./ui";
import { account, publicClient } from "./wallet";

const miningAgentAbi = miningAgentAbiJson as Abi;
const agentCoinAbi = agentCoinAbiJson as Abi;
const rarityLabels = ["Common", "Uncommon", "Rare", "Epic", "Mythic"] as const;

export async function displayStats(tokenId?: bigint): Promise<void> {
  const [totalMines, totalMinted, miningTarget, mineableSupply, eraInterval, walletBalance] = await Promise.all([
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
      functionName: "miningTarget",
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
    account
      ? (publicClient.readContract({
          address: config.agentCoinAddress,
          abi: agentCoinAbi,
          functionName: "balanceOf",
          args: [account.address],
        }) as Promise<bigint>)
      : Promise.resolve(0n),
  ]);

  const era = totalMines / eraInterval;
  const minesUntilNextEra = eraInterval - (totalMines % eraInterval);
  const supplyPct = Number(totalMinted * 10000n / mineableSupply) / 100;
  const remainingSupply = mineableSupply - totalMinted;

  // Base reward calculation (3 * 0.9^era)
  let baseReward = 3;
  for (let i = 0n; i < era; i++) {
    baseReward *= 0.9;
  }
  let nextEraReward = baseReward * 0.9;

  // Difficulty interpretation
  const targetLog = Math.log2(Number(miningTarget));
  const difficultyDesc = targetLog > 250 ? "very easy" : targetLog > 240 ? "easy" : targetLog > 220 ? "moderate" : targetLog > 200 ? "hard" : "very hard";

  console.log("");
  console.log(`  ${ui.bold("Network")}`);
  ui.table([
    ["Total mines", totalMines.toLocaleString()],
    ["Supply mined", `${Number(formatEther(totalMinted)).toLocaleString()} / ${Number(formatEther(mineableSupply)).toLocaleString()} AGENT (${supplyPct.toFixed(2)}%)`],
    ["Remaining", `${Number(formatEther(remainingSupply)).toLocaleString()} AGENT`],
    ["Era", `${era} (${minesUntilNextEra.toLocaleString()} mines until era ${(era + 1n).toString()})`],
    ["Base reward", `${baseReward.toFixed(2)} AGENT (next era: ${nextEraReward.toFixed(2)})`],
    ["Difficulty", `${difficultyDesc} (target: 2^${targetLog.toFixed(0)})`],
  ]);

  if (account && walletBalance > 0n) {
    console.log("");
    console.log(`  ${ui.bold("Wallet")}`);
    ui.table([
      ["Address", `${account.address.slice(0, 6)}...${account.address.slice(-4)}`],
      ["AGENT balance", `${Number(formatEther(walletBalance)).toLocaleString()} AGENT`],
    ]);
  }

  if (tokenId === undefined) {
    console.log("");
    return;
  }

  const [tokenMineCount, tokenEarnings, rarityRaw, hashpowerRaw, mintBlock] = await Promise.all([
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
    publicClient.readContract({
      address: config.miningAgentAddress,
      abi: miningAgentAbi,
      functionName: "rarity",
      args: [tokenId],
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
      functionName: "mintBlock",
      args: [tokenId],
    }) as Promise<bigint>,
  ]);
  const rarity = Number(rarityRaw);
  const hashpower = Number(hashpowerRaw);
  const rewardPerMine = baseReward * (hashpower / 100);

  console.log("");
  console.log(`  ${ui.bold(`Miner #${tokenId} (${rarityLabels[rarity] ?? `Tier ${rarity}`}, ${formatHashpower(hashpower)})`)}`);
  ui.table([
    ["Mine count", tokenMineCount.toLocaleString()],
    ["Earnings", `${Number(formatEther(tokenEarnings)).toLocaleString()} AGENT`],
    ["Reward/mine", `${rewardPerMine.toFixed(2)} AGENT`],
    ["Mint block", mintBlock.toLocaleString()],
    ["Basescan", tokenUrl(config.miningAgentAddress, tokenId)],
  ]);
  console.log("");
}
