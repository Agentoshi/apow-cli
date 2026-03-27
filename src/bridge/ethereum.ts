// Ethereum mainnet balance utilities for deposit detection.
// Uses viem (already a dependency) — no new packages needed.

import { createPublicClient, formatEther, http } from "viem";
import { mainnet } from "viem/chains";

const DEFAULT_ETHEREUM_RPC = "https://cloudflare-eth.com";

let client: ReturnType<typeof createPublicClient> | undefined;

export function getEthereumRpcUrl(): string {
  return process.env.ETHEREUM_RPC_URL || DEFAULT_ETHEREUM_RPC;
}

function getClient(): ReturnType<typeof createPublicClient> {
  if (!client) {
    client = createPublicClient({
      chain: mainnet,
      transport: http(getEthereumRpcUrl()),
    });
  }
  return client;
}

/** Get ETH balance for any address on Ethereum mainnet (used to detect deposits). */
export async function getAddressBalance(address: string): Promise<number> {
  const balance = await getClient().getBalance({
    address: address as `0x${string}`,
  });
  return Number(formatEther(balance));
}
