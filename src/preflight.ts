import type { Abi } from "viem";
import { formatEther } from "viem";

import agentCoinAbiJson from "./abi/AgentCoin.json";
import { config } from "./config";
import { publicClient, account } from "./wallet";
import * as ui from "./ui";

const agentCoinAbi = agentCoinAbiJson as Abi;

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

  // Check 2: RPC reachable + chain ID
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
      label: `RPC unreachable — could not connect to ${config.rpcUrl}`,
      passed: false,
      fix: "Check internet connection or update RPC_URL in .env",
    });
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
      if (config.llmProvider === "ollama") {
        results.push({ label: `LLM provider: ollama (${config.ollamaUrl})`, passed: true });
      } else if (config.llmProvider === "claude-code" || config.llmProvider === "codex") {
        results.push({ label: `LLM provider: ${config.llmProvider} (local CLI)`, passed: true });
      } else if (config.llmApiKey) {
        results.push({ label: `LLM provider: ${config.llmProvider} (key set)`, passed: true });
      } else {
        results.push({
          label: `LLM API key not set for ${config.llmProvider}`,
          passed: false,
          fix: "Set LLM_API_KEY (or OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY) in .env, or run `apow setup`",
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
