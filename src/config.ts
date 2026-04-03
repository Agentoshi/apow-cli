import { config as loadEnv } from "dotenv";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import type { Address, Chain, Hex } from "viem";
import { base, baseSepolia } from "viem/chains";

loadEnv({ quiet: true });

export type LlmProvider = "openai" | "anthropic" | "ollama" | "gemini" | "claude-code" | "codex" | "deepseek" | "qwen" | "clawrouter";
export type ChainName = "base" | "baseSepolia";

export type GrinderMode = "auto" | "js";

export interface AppConfig {
  privateKey?: Hex;
  rpcUrl: string;
  useX402: boolean;
  llmProvider: LlmProvider;
  llmApiKey?: string;
  llmModel: string;
  ollamaUrl: string;
  chain: Chain;
  chainName: ChainName;
  miningAgentAddress: Address;
  agentCoinAddress: Address;
  minerThreads: number;
  grinderMode: GrinderMode;
  gpuGrinderPath?: string;
  cpuGrinderPath?: string;
  cudaGrinderPath?: string;
  vastIp?: string;
  vastPort?: string;
  cpuGrinderThreads: number;
  remoteGrinderPath: string;
  grindUrl?: string;
  useX402Grind: boolean;
  allowLocalFallbackWithX402: boolean;
  staleCheckIntervalMs: number;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_CHAIN_NAME: ChainName = "base";
const DEFAULT_MINING_AGENT_ADDRESS = "0xB7caD3ca5F2BD8aEC2Eb67d6E8D448099B3bC03D" as Address;
const DEFAULT_AGENT_COIN_ADDRESS = "0x12577CF0D8a07363224D6909c54C056A183e13b3" as Address;

const EXPENSIVE_MODELS = ["gpt-4o", "gpt-4", "claude-3-opus", "claude-3-5-sonnet"];
const CHEAP_OVERRIDES = ["gpt-4o-mini", "gpt-4-mini"];

function normalizeProvider(value?: string, useX402?: boolean): LlmProvider {
  if (value === "anthropic" || value === "ollama" || value === "openai" || value === "gemini" || value === "claude-code" || value === "codex" || value === "deepseek" || value === "qwen" || value === "clawrouter") {
    return value;
  }

  // No explicit provider: x402 users get clawrouter (zero-credential stack), others get openai
  return useX402 ? "clawrouter" : "openai";
}

export function resolveDefaultModel(provider: LlmProvider): string {
  switch (provider) {
    case "clawrouter": return "blockrun/eco";
    case "gemini": return "gemini-2.5-flash";
    case "anthropic": return "claude-sonnet-4-5-20250929";
    case "deepseek": return "deepseek-chat";
    case "qwen": return "qwen-plus";
    case "claude-code":
    case "codex": return "default";
    default: return "gpt-4o-mini";
  }
}

function resolveChainName(): ChainName {
  const envChain = process.env.CHAIN;
  if (envChain === "base" || envChain === "baseSepolia") {
    return envChain;
  }

  const rpcUrl = process.env.RPC_URL ?? "";
  if (rpcUrl.toLowerCase().includes("sepolia")) {
    return "baseSepolia";
  }

  return DEFAULT_CHAIN_NAME;
}

function parsePrivateKey(value?: string): Hex | undefined {
  if (!value) {
    return undefined;
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("PRIVATE_KEY must be a 32-byte hex string prefixed with 0x.");
  }

  return value as Hex;
}

function parseAddress(envKey: string, fallback: Address | undefined): Address {
  const value = process.env[envKey];
  if (value && /^0x[0-9a-fA-F]{40}$/.test(value)) {
    return value as Address;
  }
  if (fallback) {
    return fallback;
  }
  // Return zero address instead of throwing — preflight checks will catch this
  return ZERO_ADDRESS;
}

function resolveLlmApiKey(provider: LlmProvider): string | undefined {
  if (provider === "claude-code" || provider === "codex" || provider === "clawrouter") return "";
  if (process.env.LLM_API_KEY) return process.env.LLM_API_KEY;
  switch (provider) {
    case "openai": return process.env.OPENAI_API_KEY;
    case "anthropic": return process.env.ANTHROPIC_API_KEY;
    case "gemini": return process.env.GEMINI_API_KEY;
    case "deepseek": return process.env.DEEPSEEK_API_KEY;
    case "qwen": return process.env.DASHSCOPE_API_KEY;
    default: return undefined;
  }
}

function resolveStaleCheckIntervalMs(): number {
  if (process.env.STALE_CHECK_INTERVAL) {
    return parseInt(process.env.STALE_CHECK_INTERVAL, 10) * 1000;
  }

  return 10_000;
}

function buildConfig(): AppConfig {
  const chainName = resolveChainName();
  const useX402 = process.env.USE_X402 === "true";
  const resolvedProvider = normalizeProvider(process.env.LLM_PROVIDER, useX402);
  const useX402Grind = process.env.USE_X402_GRIND !== undefined
    ? process.env.USE_X402_GRIND === "true"
    : useX402;
  const allowLocalFallbackWithX402 = process.env.ALLOW_LOCAL_FALLBACK_WITH_X402 === "true";

  return {
    privateKey: parsePrivateKey(process.env.PRIVATE_KEY),
    rpcUrl: process.env.RPC_URL ?? "",
    useX402,
    llmProvider: resolvedProvider,
    llmApiKey: resolveLlmApiKey(resolvedProvider),
    llmModel: process.env.LLM_MODEL ?? resolveDefaultModel(resolvedProvider),
    ollamaUrl: process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
    chain: chainName === "baseSepolia" ? baseSepolia : base,
    chainName,
    miningAgentAddress: parseAddress("MINING_AGENT_ADDRESS", DEFAULT_MINING_AGENT_ADDRESS),
    agentCoinAddress: parseAddress("AGENT_COIN_ADDRESS", DEFAULT_AGENT_COIN_ADDRESS),
    minerThreads: parseInt(process.env.MINER_THREADS ?? String(os.cpus().length), 10),
    grinderMode: (process.env.GRINDER_MODE === "js" ? "js" : "auto") as GrinderMode,
    gpuGrinderPath: process.env.GPU_GRINDER_PATH,
    cpuGrinderPath: process.env.CPU_GRINDER_PATH,
    cudaGrinderPath: process.env.CUDA_GRINDER_PATH,
    vastIp: process.env.VAST_IP,
    vastPort: process.env.VAST_PORT,
    cpuGrinderThreads: parseInt(process.env.CPU_THREADS ?? String(os.cpus().length), 10),
    remoteGrinderPath: process.env.REMOTE_GRINDER ?? "/root/grinder-cuda",
    grindUrl: process.env.GRIND_URL,
    useX402Grind,
    allowLocalFallbackWithX402,
    staleCheckIntervalMs: resolveStaleCheckIntervalMs(),
  };
}

export let config: AppConfig = buildConfig();

export function reloadConfig(): AppConfig {
  config = buildConfig();
  return config;
}

export function requirePrivateKey(): Hex {
  if (!config.privateKey) {
    throw new Error("PRIVATE_KEY is required for minting and mining commands.");
  }

  return config.privateKey;
}

export function requireLlmApiKey(): string {
  if (config.llmProvider === "ollama" || config.llmProvider === "claude-code" || config.llmProvider === "codex" || config.llmProvider === "clawrouter") {
    return "";
  }

  if (!config.llmApiKey) {
    const keyNames: Record<string, string> = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY", deepseek: "DEEPSEEK_API_KEY", qwen: "DASHSCOPE_API_KEY" };
    const alt = keyNames[config.llmProvider] ?? "";
    throw new Error(`LLM_API_KEY${alt ? ` (or ${alt})` : ""} is required for ${config.llmProvider}.`);
  }

  return config.llmApiKey;
}

export function isExpensiveModel(model: string): boolean {
  const m = model.toLowerCase();
  if (CHEAP_OVERRIDES.some((c) => m.startsWith(c))) return false;
  return EXPENSIVE_MODELS.some((e) => m.startsWith(e));
}

export async function writeEnvFile(values: Record<string, string>): Promise<void> {
  const lines = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  await writeFile(join(process.cwd(), ".env"), lines + "\n", "utf8");
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
  reloadConfig();
}
