import type { Abi, Address, PublicClient } from "viem";

import miningAgentAbiJson from "./abi/MiningAgent.json";
import { config } from "./config";
import { publicClient } from "./wallet";

const miningAgentAbi = miningAgentAbiJson as Abi;
export const rarityLabels = ["Common", "Uncommon", "Rare", "Epic", "Mythic"] as const;

export interface OwnedMiner {
  tokenId: bigint;
  rarity: number;
  rarityLabel: string;
  hashpower: number;
}

export async function detectMinersWithClient(client: PublicClient, owner: Address): Promise<OwnedMiner[]> {
  const balance = (await client.readContract({
    address: config.miningAgentAddress,
    abi: miningAgentAbi,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint;

  if (balance === 0n) {
    return [];
  }

  const miners: OwnedMiner[] = [];

  for (let i = 0n; i < balance; i++) {
    const tokenId = (await client.readContract({
      address: config.miningAgentAddress,
      abi: miningAgentAbi,
      functionName: "tokenOfOwnerByIndex",
      args: [owner, i],
    })) as bigint;

    const [rarityRaw, hashpowerRaw] = await Promise.all([
      client.readContract({
        address: config.miningAgentAddress,
        abi: miningAgentAbi,
        functionName: "rarity",
        args: [tokenId],
      }) as Promise<bigint>,
      client.readContract({
        address: config.miningAgentAddress,
        abi: miningAgentAbi,
        functionName: "hashpower",
        args: [tokenId],
      }) as Promise<bigint>,
    ]);

    const rarity = Number(rarityRaw);
    miners.push({
      tokenId,
      rarity,
      rarityLabel: rarityLabels[rarity] ?? `Tier ${rarity}`,
      hashpower: Number(hashpowerRaw),
    });
  }

  return miners;
}

export async function detectMiners(owner: Address): Promise<OwnedMiner[]> {
  return detectMinersWithClient(publicClient, owner);
}

export function selectBestMiner(miners: OwnedMiner[]): OwnedMiner {
  return miners.reduce((best, m) => (m.hashpower > best.hashpower ? m : best));
}

export function formatHashpower(hashpower: number): string {
  return `${(hashpower / 100).toFixed(2)}x`;
}
