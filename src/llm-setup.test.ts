import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveApiProvider,
  resolveLlmSetupMode,
  resolveLocalProvider,
} from "./llm-setup";

test("Step 3 resolves numbered and named LLM modes", () => {
  assert.equal(resolveLlmSetupMode("1"), "x402");
  assert.equal(resolveLlmSetupMode("api-key"), "api-key");
  assert.equal(resolveLlmSetupMode("3"), "local");
  assert.equal(resolveLlmSetupMode("invalid"), "x402");
});

test("Step 3 resolves API-key providers", () => {
  assert.equal(resolveApiProvider("1"), "openai");
  assert.equal(resolveApiProvider("anthropic"), "anthropic");
  assert.equal(resolveApiProvider("3"), "gemini");
  assert.equal(resolveApiProvider("5"), "qwen");
  assert.equal(resolveApiProvider("invalid"), "openai");
});

test("Step 3 resolves local and subscription CLI providers", () => {
  assert.equal(resolveLocalProvider("1"), "ollama");
  assert.equal(resolveLocalProvider("claude"), "claude-code");
  assert.equal(resolveLocalProvider("3"), "codex");
  assert.equal(resolveLocalProvider("invalid"), "ollama");
});
