import { config as loadEnv } from "dotenv";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Address, Chain, Hex } from "viem";
import { base, baseSepolia } from "viem/chains";

loadEnv();

export type LlmProvider = "openai" | "anthropic" | "ollama" | "gemini" | "claude-code" | "codex" | "deepseek" | "qwen";
export type ChainName = "base" | "baseSepolia";

export interface AppConfig {
  privateKey?: Hex;
  rpcUrl: string;
  llmProvider: LlmProvider;
  llmApiKey?: string;
  llmModel: string;
  ollamaUrl: string;
  chain: Chain;
  chainName: ChainName;
  miningAgentAddress: Address;
  agentCoinAddress: Address;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

const DEFAULT_RPC_URL = "https://mainnet.base.org";
const DEFAULT_LLM_PROVIDER: LlmProvider = "openai";
const DEFAULT_LLM_MODEL = "gpt-4o-mini";
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_CHAIN_NAME: ChainName = "base";
const DEFAULT_MINING_AGENT_ADDRESS = "0xB7caD3ca5F2BD8aEC2Eb67d6E8D448099B3bC03D" as Address;
const DEFAULT_AGENT_COIN_ADDRESS = "0x12577CF0D8a07363224D6909c54C056A183e13b3" as Address;

const EXPENSIVE_MODELS = ["gpt-4o", "gpt-4", "claude-3-opus", "claude-3-5-sonnet"];
const CHEAP_OVERRIDES = ["gpt-4o-mini", "gpt-4-mini"];

function normalizeProvider(value?: string): LlmProvider {
  if (value === "anthropic" || value === "ollama" || value === "openai" || value === "gemini" || value === "claude-code" || value === "codex" || value === "deepseek" || value === "qwen") {
    return value;
  }

  return DEFAULT_LLM_PROVIDER;
}

function resolveChainName(): ChainName {
  const envChain = process.env.CHAIN;
  if (envChain === "base" || envChain === "baseSepolia") {
    return envChain;
  }

  const rpcUrl = process.env.RPC_URL ?? DEFAULT_RPC_URL;
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
  if (provider === "claude-code" || provider === "codex") return "";
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

const chainName = resolveChainName();

export const config: AppConfig = {
  privateKey: parsePrivateKey(process.env.PRIVATE_KEY),
  rpcUrl: process.env.RPC_URL ?? DEFAULT_RPC_URL,
  llmProvider: normalizeProvider(process.env.LLM_PROVIDER),
  llmApiKey: resolveLlmApiKey(normalizeProvider(process.env.LLM_PROVIDER)),
  llmModel: process.env.LLM_MODEL ?? DEFAULT_LLM_MODEL,
  ollamaUrl: process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
  chain: chainName === "baseSepolia" ? baseSepolia : base,
  chainName,
  miningAgentAddress: parseAddress("MINING_AGENT_ADDRESS", DEFAULT_MINING_AGENT_ADDRESS),
  agentCoinAddress: parseAddress("AGENT_COIN_ADDRESS", DEFAULT_AGENT_COIN_ADDRESS),
};

export function requirePrivateKey(): Hex {
  if (!config.privateKey) {
    throw new Error("PRIVATE_KEY is required for minting and mining commands.");
  }

  return config.privateKey;
}

export function requireLlmApiKey(): string {
  if (config.llmProvider === "ollama" || config.llmProvider === "claude-code" || config.llmProvider === "codex") {
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
}
