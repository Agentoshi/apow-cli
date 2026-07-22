import assert from "node:assert/strict";
import { test } from "node:test";

import { usdcRequired } from "./config";
import type { AppConfig } from "./config";

// usdcRequired drives the whole ETH-only funding model: USDC is needed only when
// an x402 pay-per-call service spends it. Build minimal config shapes to assert
// the truth table without touching real env/wallet state.
function cfg(over: Partial<AppConfig>): AppConfig {
  return { useX402: false, useX402Grind: false, llmProvider: "codex", ...over } as AppConfig;
}

test("ETH-only: own RPC + local LLM + local grinder needs no USDC", () => {
  assert.equal(usdcRequired(cfg({ useX402: false, useX402Grind: false, llmProvider: "codex" })), false);
  assert.equal(usdcRequired(cfg({ llmProvider: "openai" })), false);
});

test("x402 RPC requires USDC", () => {
  assert.equal(usdcRequired(cfg({ useX402: true })), true);
});

test("x402 GPU grind requires USDC", () => {
  assert.equal(usdcRequired(cfg({ useX402Grind: true })), true);
});

test("ClawRouter LLM requires USDC even with own RPC + local grinder", () => {
  assert.equal(usdcRequired(cfg({ useX402: false, useX402Grind: false, llmProvider: "clawrouter" })), true);
});
