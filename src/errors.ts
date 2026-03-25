export type ErrorCategory = "setup" | "transient" | "fatal" | "llm";

export interface ClassifiedError {
  category: ErrorCategory;
  userMessage: string;
  recovery: string;
}

const patterns: Array<{
  test: (msg: string) => boolean;
  classify: (msg: string) => ClassifiedError;
}> = [
  {
    test: (m) => m.includes("Not your miner"),
    classify: () => ({
      category: "fatal",
      userMessage: "Miner NFT is not owned by your wallet",
      recovery: "Check token ID or verify ownership on Basescan",
    }),
  },
  {
    test: (m) => m.includes("Supply exhausted"),
    classify: () => ({
      category: "fatal",
      userMessage: "All 18.9M mineable AGENT have been mined",
      recovery: "Mining is complete. Trade AGENT on Uniswap.",
    }),
  },
  {
    test: (m) => m.includes("No contracts"),
    classify: () => ({
      category: "fatal",
      userMessage: "Smart contract wallets cannot mine",
      recovery: "Use a regular (EOA) wallet",
    }),
  },
  {
    test: (m) => m.includes("Sold out") || m.includes("Max supply"),
    classify: () => ({
      category: "fatal",
      userMessage: "All 10,000 mining rigs have been minted",
      recovery: "Buy a miner NFT on a secondary marketplace",
    }),
  },
  {
    test: (m) => m.includes("One mine per block"),
    classify: () => ({
      category: "transient",
      userMessage: "One mine per block — waiting for next block",
      recovery: "",
    }),
  },
  {
    test: (m) => m.includes("Expired"),
    classify: () => ({
      category: "transient",
      userMessage: "SMHL challenge expired (20s window)",
      recovery: "Retrying with a fresh challenge...",
    }),
  },
  {
    test: (m) => m.includes("fetch failed") || m.includes("ECONNREFUSED") || m.includes("ENOTFOUND"),
    classify: (msg) => {
      const target = msg.includes("11434") ? "Ollama" : msg.includes("anthropic") ? "Anthropic API" : msg.includes("openai") ? "OpenAI API" : "RPC";
      return {
        category: "transient",
        userMessage: `Could not reach ${target}`,
        recovery: "Check internet connection and RPC_URL in .env",
      };
    },
  },
  {
    test: (m) => /\b40[13]\b/.test(m) && (m.includes("anthropic") || m.includes("openai") || m.toLowerCase().includes("unauthorized") || m.toLowerCase().includes("forbidden")),
    classify: () => ({
      category: "setup",
      userMessage: "LLM API key is invalid or expired",
      recovery: "Run `apow setup` to configure a valid key",
    }),
  },
  {
    test: (m) => /\b402\b/.test(m) || m.toLowerCase().includes("x402") || (m.toLowerCase().includes("insufficient") && m.toLowerCase().includes("usdc")),
    classify: () => ({
      category: "transient",
      userMessage: "QuickNode x402 credit purchase failed — check USDC balance on Base",
      recovery: "Send USDC to your wallet on Base (~$10 for ~1M RPC calls), or set RPC_URL in .env to use a custom RPC",
    }),
  },
  {
    test: (m) => m.toLowerCase().includes("insufficient funds"),
    classify: () => ({
      category: "setup",
      userMessage: "Not enough ETH for gas",
      recovery: "Send ETH to your wallet on Base",
    }),
  },
  {
    test: (m) => m.includes("SMHL solve failed"),
    classify: () => ({
      category: "llm",
      userMessage: "LLM failed to solve the SMHL challenge after 5 attempts",
      recovery: "Try a different model (gpt-4o-mini recommended) or check your LLM API key",
    }),
  },
  {
    test: (m) => m.includes("EADDRINUSE") && m.includes("8402"),
    classify: () => ({
      category: "setup",
      userMessage: "ClawRouter proxy port 8402 is already in use",
      recovery: "Set CLAWROUTER_PORT in .env to use a different port",
    }),
  },
  {
    test: (m) => m.toLowerCase().includes("insufficient") && m.toLowerCase().includes("clawrouter"),
    classify: () => ({
      category: "setup",
      userMessage: "Insufficient USDC for ClawRouter x402 LLM payment",
      recovery: "Send USDC to your wallet on Base",
    }),
  },
  {
    test: (m) => m.includes("INSUFFICIENT_OUTPUT_AMOUNT") || m.includes("Too little received"),
    classify: () => ({
      category: "transient",
      userMessage: "Uniswap swap failed — slippage exceeded",
      recovery: "Price moved during swap. Try again — the auto-split will recalculate.",
    }),
  },
  {
    test: (m) => m.includes("swap reverted"),
    classify: () => ({
      category: "transient",
      userMessage: "Uniswap swap transaction reverted",
      recovery: "Try again. If persistent, check ETH/USDC balances on Base.",
    }),
  },
  {
    test: (m) => m.includes("Squid") && (m.includes("route") || m.includes("deposit")),
    classify: () => ({
      category: "transient",
      userMessage: "Bridge route temporarily unavailable",
      recovery: "Wait a few minutes and try again",
    }),
  },
];

export function classifyError(error: unknown): ClassifiedError {
  const message = error instanceof Error ? error.message : String(error);

  for (const pattern of patterns) {
    if (pattern.test(message)) {
      return pattern.classify(message);
    }
  }

  return {
    category: "transient",
    userMessage: message.length > 200 ? message.slice(0, 200) + "..." : message,
    recovery: "",
  };
}
