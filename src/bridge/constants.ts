// Shared chain IDs, token addresses, and types for cross-chain bridging.

export const CHAIN_IDS = {
  solana:   "solana",
  ethereum: "1",
  base:     "8453",
} as const;

export const TOKENS = {
  solana: {
    native: "11111111111111111111111111111111",
    nativeWrapped: "So11111111111111111111111111111111111111112",
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
  ethereum: {
    native: "0x0000000000000000000000000000000000000000",
    nativeWrapped: "0xC02aaA39b223FE8D0A5827d8EE69cFde63831e7e",
  },
  base: {
    native: "0x0000000000000000000000000000000000000000",
    nativeSquid: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    weth: "0x4200000000000000000000000000000000000006" as `0x${string}`,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`,
  },
} as const;

export type SourceChain = "solana" | "ethereum" | "base";
export type SourceToken = "native" | "usdc";
export type BaseAsset = "eth" | "usdc";

export function bridgeOutputAsset(token: SourceToken): BaseAsset {
  return token === "usdc" ? "usdc" : "eth";
}

export const MIN_ETH = 0.003;
export const MIN_USDC = 2.0;
export const SLIPPAGE_BPS = 200; // 2%
