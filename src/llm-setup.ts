import type { LlmProvider } from "./config";

export type LlmSetupMode = "x402" | "api-key" | "local";

export function resolveLlmSetupMode(input: string): LlmSetupMode {
  const value = input.trim().toLowerCase();
  if (value === "2" || value === "api" || value === "api-key") return "api-key";
  if (value === "3" || value === "local" || value === "subscription") return "local";
  return "x402";
}

export function resolveApiProvider(input: string): LlmProvider {
  const value = input.trim().toLowerCase();
  const choices: Record<string, LlmProvider> = {
    "1": "openai",
    openai: "openai",
    "2": "anthropic",
    anthropic: "anthropic",
    "3": "gemini",
    gemini: "gemini",
    "4": "deepseek",
    deepseek: "deepseek",
    "5": "qwen",
    qwen: "qwen",
  };
  return choices[value] ?? "openai";
}

export function resolveLocalProvider(input: string): LlmProvider {
  const value = input.trim().toLowerCase();
  const choices: Record<string, LlmProvider> = {
    "1": "ollama",
    ollama: "ollama",
    "2": "claude-code",
    claude: "claude-code",
    "claude-code": "claude-code",
    "3": "codex",
    codex: "codex",
  };
  return choices[value] ?? "ollama";
}
