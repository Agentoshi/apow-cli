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

  const indexes = Array.from({ length: Number(balance) }, (_, i) => BigInt(i));
  const tokenIds = await Promise.all(indexes.map((index) =>
    client.readContract({
      address: config.miningAgentAddress,
      abi: miningAgentAbi,
      functionName: "tokenOfOwnerByIndex",
      args: [owner, index],
    }) as Promise<bigint>,
  ));

  const miners = await Promise.all(tokenIds.map(async (tokenId) => {
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
    return {
      tokenId,
      rarity,
      rarityLabel: rarityLabels[rarity] ?? `Tier ${rarity}`,
      hashpower: Number(hashpowerRaw),
    };
  }));

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
