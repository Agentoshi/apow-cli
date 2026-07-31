import { spawnSync } from "node:child_process";
import type { Abi, Address } from "viem";
import { createPublicClient, formatEther, formatUnits, http, parseEther } from "viem";
import { base } from "viem/chains";

import agentCoinAbiJson from "./abi/AgentCoin.json";
import miningAgentAbiJson from "./abi/MiningAgent.json";
import { config } from "./config";
import { redactUrls } from "./errors";
import { getGrindUrl, isHttpGrinderConfigured } from "./grinder-http";
import { loadPolicy } from "./policy/policy";
import { spentTodayUsdc } from "./policy/spend-ledger";
import { claudeSubscriptionEnv, codexSubscriptionEnv } from "./secure-env";
import { publicClient, account } from "./wallet";
import * as ui from "./ui";

const agentCoinAbi = agentCoinAbiJson as Abi;
const miningAgentAbi = miningAgentAbiJson as Abi;

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const USDC_DECIMALS = 6;
const MINT_GAS_RESERVE_ETH = parseEther("0.003");

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

function runLocalCliCheck(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { passed: boolean; output: string } {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env,
    timeout: 5_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    passed: result.status === 0,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

function hasLocalCli(command: string, env: NodeJS.ProcessEnv): boolean {
  return runLocalCliCheck(command, ["--version"], env).passed;
}

function hasClaudeSubscriptionAuth(): boolean {
  const result = runLocalCliCheck("claude", ["auth", "status"], claudeSubscriptionEnv());
  return result.passed && /claude\.ai|subscription/i.test(result.output);
}

function hasCodexSubscriptionAuth(): boolean {
  const result = runLocalCliCheck("codex", ["login", "status"], codexSubscriptionEnv());
  return result.passed && /chatgpt/i.test(result.output);
}

async function checkOllamaReadiness(): Promise<CheckResult> {
  const endpoint = `${config.ollamaUrl.replace(/\/+$/, "")}/api/tags`;
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = (await response.json()) as {
      models?: Array<{ name?: string; model?: string }>;
    };
    const expected = config.llmModel.split(":")[0];
    const installed = (data.models ?? []).some(({ name, model }) => {
      const candidate = name ?? model ?? "";
      return candidate === config.llmModel || candidate.split(":")[0] === expected;
    });
    if (!installed) {
      return {
        label: `LLM provider: ollama is missing ${config.llmModel}`,
        passed: false,
        fix: `Run \`ollama pull ${config.llmModel}\`, then retry`,
      };
    }
    return {
      label: `LLM provider: ollama (${config.llmModel}, local inference)`,
      passed: true,
    };
  } catch {
    return {
      label: `LLM provider: ollama is unreachable at ${redactUrls(config.ollamaUrl)}`,
      passed: false,
      fix: "Install and start Ollama, then retry",
    };
  }
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
      fix: "Set USE_X402=true in .env, or run `apow setup` and choose Easy Mode, or set RPC_URL to a Base endpoint",
    });
  }

  // Check x402: USDC balance BEFORE RPC check (can't use x402 without USDC)
  let x402Funded = false;
  if (config.useX402 && account) {
    if (!config.rpcUrl) {
      x402Funded = true; // optimistic — the x402 RPC check below will verify reachability.
      ui.warn("Skipping x402 USDC precheck because RPC_URL is not set; refusing to use public Base RPC endpoints");
    } else {
      try {
        // Use a separate lightweight client to avoid chicken-and-egg
        // (can't use x402 to check if we can pay for x402)
        const checkClient = createPublicClient({
          chain: base,
          transport: http(config.rpcUrl),
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
            fix: `Send at least 2.00 USDC to ${account.address} on Base for x402 starting balance; add more if you want extra headroom. Run \`apow fund\` to bridge from Solana or Ethereum.`,
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
  }

  // Check 2: RPC reachable + chain ID
  // Skip when: no RPC configured at all, or x402 active but unfunded
  const hasRpc = config.useX402 || !!config.rpcUrl;
  let rpcReachable = false;
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
        rpcReachable = true;
        results.push({ label: `RPC connected — ${config.chain.name}`, passed: true });
      }
    } catch {
      results.push({
        label: `RPC unreachable — could not connect to ${config.useX402 ? "QuickNode x402" : redactUrls(config.rpcUrl)}`,
        passed: false,
        fix: config.useX402
          ? "Check internet connection and USDC balance, or set RPC_URL in .env for a custom RPC"
          : "Check internet connection or update RPC_URL in .env",
      });
    }
  }

  if (level === "wallet" || level === "mining") {
    const policy = loadPolicy();
    const spent = account ? spentTodayUsdc(account.address) : 0;
    const remaining = Math.max(0, policy.x402.dailyUsdc - spent);
    results.push({
      label: `Policy: ${policy.mode} (${remaining.toFixed(2)} USDC x402 budget remaining today)`,
      passed: true,
    });

    // Check 3: Private key valid
    if (account) {
      const source = config.walletSource === "keystore" ? "encrypted keystore" : "legacy PRIVATE_KEY";
      results.push({
        label: `Wallet signer unlocked via ${source} (${account.address.slice(0, 6)}...${account.address.slice(-4)})`,
        passed: true,
      });
    } else if (config.keystorePath && config.walletLoadError) {
      results.push({
        label: "Encrypted keystore locked",
        passed: false,
        fix: config.walletLoadError,
      });
    } else {
      results.push({
        label: "Private key not configured",
        passed: false,
        fix: "Run `apow setup` and choose Easy Mode, or set KEYSTORE_PATH to an encrypted keystore",
      });
    }

    // Check 4: Wallet has ETH (skip if RPC already failed — avoids duplicate errors)
    if (account && rpcReachable) {
      try {
        const balance = await publicClient.getBalance({ address: account.address });
        const ethBalance = Number(formatEther(balance));
        if (level === "wallet") {
          const mintPrice = (await publicClient.readContract({
            address: config.miningAgentAddress,
            abi: miningAgentAbi,
            functionName: "getMintPrice",
          })) as bigint;
          const requiredBalance = mintPrice + MINT_GAS_RESERVE_ETH;

          if (balance < requiredBalance) {
            results.push({
              label: `Mint-ready ETH balance (${ethBalance.toFixed(6)} ETH)`,
              passed: false,
              fix: `Mint needs ${formatEther(mintPrice)} ETH for the rig plus ~${formatEther(MINT_GAS_RESERVE_ETH)} ETH for the getChallenge and mint transactions. Send at least ${formatEther(requiredBalance)} ETH to ${account.address} on Base.`,
            });
          } else {
            results.push({
              label: `Mint-ready ETH balance (${ethBalance.toFixed(6)} ETH)`,
              passed: true,
            });
          }
        } else if (ethBalance < 0.001) {
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

    // Check 5: LLM provider readiness (required for minting only)
    if (level === "wallet") {
      if (config.llmProvider === "clawrouter") {
        if (!account) {
          results.push({
            label: "The x402 LLM service requires an unlocked wallet signer",
            passed: false,
            fix: "Unlock KEYSTORE_PATH with KEYSTORE_PASSWORD",
          });
        } else {
          results.push({
            label: "LLM provider: automatic x402 model selection",
            passed: true,
          });
        }
      } else if (config.llmProvider === "ollama") {
        results.push(await checkOllamaReadiness());
      } else if (config.llmProvider === "claude-code") {
        const env = claudeSubscriptionEnv();
        if (!hasLocalCli("claude", env)) {
          results.push({
            label: "LLM provider claude-code not installed",
            passed: false,
            fix: "Install Claude Code or switch to LLM_PROVIDER=clawrouter",
          });
        } else if (hasClaudeSubscriptionAuth()) {
          results.push({
            label: "LLM provider: Claude Code (Claude subscription authenticated)",
            passed: true,
          });
        } else {
          results.push({
            label: "Claude Code is not signed in with a Claude subscription",
            passed: false,
            fix: "Run `claude login`, choose your Claude.ai subscription, then retry",
          });
        }
      } else if (config.llmProvider === "codex") {
        const env = codexSubscriptionEnv();
        if (!hasLocalCli("codex", env)) {
          results.push({
            label: "LLM provider codex not installed",
            passed: false,
            fix: "Install Codex CLI or switch to LLM_PROVIDER=clawrouter",
          });
        } else if (hasCodexSubscriptionAuth()) {
          results.push({
            label: "LLM provider: Codex (ChatGPT subscription authenticated)",
            passed: true,
          });
        } else {
          results.push({
            label: "Codex is not signed in with ChatGPT",
            passed: false,
            fix: "Run `codex login`, choose ChatGPT subscription access, then retry",
          });
        }
      } else if (config.llmApiKey) {
        results.push({ label: `LLM provider: ${config.llmProvider} (key set)`, passed: true });
      } else {
        results.push({
          label: `LLM API key not set for ${config.llmProvider}`,
          passed: false,
        fix: "Set LLM_API_KEY in .env, or switch to LLM_PROVIDER=clawrouter (no API key; wallet-paid in USDC)",
        });
      }
    }
  }

  // Check 6: Contracts exist on-chain (bytecode check) — skip if RPC is unreachable
  if (!rpcReachable) {
    // Don't pile on errors when RPC is already known to be down
  } else try {
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
    const grinderIsRequired = !config.allowLocalFallbackWithX402;
    try {
      const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const host = new URL(grindUrl).hostname;
        results.push({ label: `GrindProxy: ${host} (dynamic pricing)`, passed: true });
      } else {
        results.push({
          label: grinderIsRequired
            ? "GrindProxy unreachable (required in Easy Mode)"
            : "GrindProxy unreachable (will use local grinders only)",
          passed: !grinderIsRequired,
          fix: grinderIsRequired
            ? "Check internet connection, grind.apow.io status, or switch to Advanced Mode with local/custom grinders"
            : undefined,
        });
      }
    } catch {
      results.push({
        label: grinderIsRequired
          ? "GrindProxy unreachable (required in Easy Mode)"
          : "GrindProxy unreachable (will use local grinders only)",
        passed: !grinderIsRequired,
        fix: grinderIsRequired
          ? "Check internet connection, grind.apow.io status, or switch to Advanced Mode with local/custom grinders"
          : undefined,
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
