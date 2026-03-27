import type { Abi, Address } from "viem";
import { createPublicClient, formatEther, formatUnits, http } from "viem";
import { base } from "viem/chains";

import agentCoinAbiJson from "./abi/AgentCoin.json";
import { config } from "./config";
import { getGrindUrl, isHttpGrinderConfigured } from "./grinder-http";
import { publicClient, account } from "./wallet";
import * as ui from "./ui";

const agentCoinAbi = agentCoinAbiJson as Abi;

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const USDC_DECIMALS = 6;

const erc20BalanceAbi = [
  {
    type: "function" as const,
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view" as const,
  },
] as const;

export type PreflightLevel = "readonly" | "wallet" | "mining";

interface CheckResult {
  label: string;
  passed: boolean;
  fix?: string;
}

export async function runPreflight(level: PreflightLevel): Promise<void> {
  const results: CheckResult[] = [];

  // Check 1: Contract addresses set
  const zeroAddr = "0x0000000000000000000000000000000000000000";
  if (config.miningAgentAddress === zeroAddr || config.agentCoinAddress === zeroAddr) {
    results.push({
      label: "Contract addresses not configured",
      passed: false,
      fix: "Set MINING_AGENT_ADDRESS and AGENT_COIN_ADDRESS in .env",
    });
  } else {
    results.push({ label: "Contract addresses configured", passed: true });
  }

  // Check: RPC configured (either RPC_URL or USE_X402)
  if (!config.useX402 && !config.rpcUrl) {
    results.push({
      label: "No RPC configured",
      passed: false,
      fix: "Set USE_X402=true in .env (auto-pay with USDC), or set RPC_URL to a Base endpoint, or run `apow setup`",
    });
  }

  // Check x402: USDC balance BEFORE RPC check (can't use x402 without USDC)
  let x402Funded = false;
  if (config.useX402 && account) {
    try {
      // Use a separate lightweight client to avoid chicken-and-egg
      // (can't use x402 to check if we can pay for x402)
      const checkClient = createPublicClient({
        chain: base,
        transport: http("https://mainnet.base.org"),
      });
      const usdcBalance = (await checkClient.readContract({
        address: USDC_ADDRESS,
        abi: erc20BalanceAbi,
        functionName: "balanceOf",
        args: [account.address],
      })) as bigint;

      if (usdcBalance === 0n) {
        results.push({
          label: "No USDC balance — QuickNode x402 requires USDC on Base",
          passed: false,
          fix: `Send USDC to ${account.address} on Base (~$10 covers ${config.llmProvider === "clawrouter" ? "both RPC and LLM calls" : "~1M RPC calls"}). Run \`apow fund\` to bridge from Solana.`,
        });
      } else {
        x402Funded = true;
        const formatted = formatUnits(usdcBalance, USDC_DECIMALS);
        results.push({
          label: `RPC: QuickNode x402 (${formatted} USDC available)`,
          passed: true,
        });
      }
    } catch {
      // USDC check failed — can't verify, warn but don't block
      x402Funded = true; // optimistic — let the RPC check determine reachability
      ui.warn("Could not check USDC balance — QuickNode x402 may fail if wallet has no USDC");
    }
  }

  // Check 2: RPC reachable + chain ID
  // Skip when: no RPC configured at all, or x402 active but unfunded
  const hasRpc = config.useX402 || !!config.rpcUrl;
  if (hasRpc && (!config.useX402 || x402Funded)) {
    try {
      const chainId = await publicClient.getChainId();
      const expectedId = config.chain.id;
      if (chainId !== expectedId) {
        results.push({
          label: `RPC chain mismatch — expected ${expectedId}, got ${chainId}`,
          passed: false,
          fix: "Update RPC_URL to point to the correct network",
        });
      } else {
        results.push({ label: `RPC connected — ${config.chain.name}`, passed: true });
      }
    } catch {
      results.push({
        label: `RPC unreachable — could not connect to ${config.useX402 ? "QuickNode x402" : config.rpcUrl}`,
        passed: false,
        fix: config.useX402
          ? "Check internet connection and USDC balance, or set RPC_URL in .env for a custom RPC"
          : "Check internet connection or update RPC_URL in .env",
      });
    }
  }

  if (level === "wallet" || level === "mining") {
    // Check 3: Private key valid
    if (account) {
      results.push({
        label: `Private key valid (${account.address.slice(0, 6)}...${account.address.slice(-4)})`,
        passed: true,
      });
    } else {
      results.push({
        label: "Private key not configured",
        passed: false,
        fix: "Set PRIVATE_KEY in .env (0x-prefixed 32-byte hex)",
      });
    }

    // Check 4: Wallet has ETH
    if (account) {
      try {
        const balance = await publicClient.getBalance({ address: account.address });
        const ethBalance = Number(formatEther(balance));
        if (ethBalance < 0.001) {
          results.push({
            label: `Low ETH balance (${ethBalance.toFixed(6)} ETH)`,
            passed: false,
            fix: `Send ETH to ${account.address} on Base`,
          });
        } else {
          results.push({ label: `ETH balance: ${ethBalance.toFixed(6)} ETH`, passed: true });
        }
      } catch {
        results.push({
          label: "Could not check ETH balance",
          passed: false,
          fix: "Verify RPC connection",
        });
      }
    }

    // Check 5: LLM key set (only required for minting, not mining)
    if (level === "wallet") {
      if (config.llmProvider === "clawrouter") {
        if (!account) {
          results.push({
            label: "ClawRouter requires PRIVATE_KEY (wallet signs x402 payments)",
            passed: false,
            fix: "Set PRIVATE_KEY in .env",
          });
        } else {
          results.push({
            label: `LLM provider: clawrouter (x402, same wallet as mining)`,
            passed: true,
          });
        }
      } else if (config.llmProvider === "ollama") {
        results.push({ label: `LLM provider: ollama (${config.ollamaUrl})`, passed: true });
      } else if (config.llmProvider === "claude-code" || config.llmProvider === "codex") {
        results.push({ label: `LLM provider: ${config.llmProvider} (local CLI)`, passed: true });
      } else if (config.llmApiKey) {
        results.push({ label: `LLM provider: ${config.llmProvider} (key set)`, passed: true });
      } else {
        results.push({
          label: `LLM API key not set for ${config.llmProvider}`,
          passed: false,
          fix: "Set LLM_API_KEY in .env, or switch to LLM_PROVIDER=clawrouter (zero credentials, pays with USDC)",
        });
      }
    }
  }

  // Check 6: Contracts exist on-chain (bytecode check)
  try {
    const [miningAgentCode, agentCoinCode] = await Promise.all([
      publicClient.getCode({ address: config.miningAgentAddress }),
      publicClient.getCode({ address: config.agentCoinAddress }),
    ]);
    if (!miningAgentCode || miningAgentCode === "0x") {
      results.push({
        label: "MiningAgent contract not found on-chain",
        passed: false,
        fix: "Verify MINING_AGENT_ADDRESS is correct for this network",
      });
    } else if (!agentCoinCode || agentCoinCode === "0x") {
      results.push({
        label: "AgentCoin contract not found on-chain",
        passed: false,
        fix: "Verify AGENT_COIN_ADDRESS is correct for this network",
      });
    } else {
      results.push({ label: "Contracts verified on-chain", passed: true });
    }
  } catch {
    // Skip if contract addresses not configured (already caught above)
  }

  // Check: GrindProxy reachability (mining only, non-blocking)
  if (level === "mining" && isHttpGrinderConfigured()) {
    const grindUrl = getGrindUrl();
    const healthUrl = grindUrl.replace(/\/grind$/, "/health");
    try {
      const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const host = new URL(grindUrl).hostname;
        results.push({ label: `GrindProxy: ${host} ($0.01/grind)`, passed: true });
      } else {
        results.push({
          label: "GrindProxy unreachable (will use local grinders only)",
          passed: true, // warn but don't fail — local grinders still work
        });
      }
    } catch {
      results.push({
        label: "GrindProxy unreachable (will use local grinders only)",
        passed: true,
      });
    }
  }

  const failures = results.filter((r) => !r.passed);
  if (failures.length > 0) {
    console.log("");
    console.log(`  ${ui.red("Pre-flight failed:")}`);
    for (const r of results) {
      if (r.passed) {
        ui.ok(r.label);
      } else {
        ui.fail(r.label);
        if (r.fix) ui.hint(`Fix: ${r.fix}`);
      }
    }
    console.log("");
    process.exit(1);
  }
}
