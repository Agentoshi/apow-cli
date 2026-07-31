import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { getAddress, parseEther } from "viem";

import { config } from "../config";
import { calldataSelector, isPermitTypedData, parseEip3009, parseErc20Approve, parseErc20Transfer, SELECTORS, SWAP_ROUTER02, USDC_ADDRESS } from "./decode";
import { policyPath } from "./paths";
import { spentTodayUsdc } from "./spend-ledger";
import type { SignerContext } from "./context";

export type PolicyMode = "enforce" | "warn" | "off";

export interface PolicyConfig {
  mode: PolicyMode;
  payout?: Address;
  maxMintEth: string;
  maxSwapEth: string;
  maxEthTransferEth: string;
  x402: {
    maxPerRequestUsdc: number;
    dailyUsdc: number;
    payees: Address[];
  };
  sweep: {
    auto: boolean;
    thresholdAgent: string;
  };
}

export interface Verdict {
  verdict: "allow" | "warn" | "deny";
  rule: string;
  hint?: string;
  kind: "mine" | "mint" | "challenge" | "sweep" | "x402" | "fund-swap" | "eth-send" | "other";
  payee?: Address;
  usdc?: number;
}

export const EASY_MODE_POLICY_CAPS = {
  maxMintEth: "0.01",
  maxPerRequestUsdc: 1,
  dailyUsdc: 20,
} as const;

export class PolicyDeniedError extends Error {
  readonly rule: string;
  readonly hint: string;

  constructor(rule: string, hint: string) {
    super(`Policy denied: ${rule}. ${hint}`);
    this.name = "PolicyDeniedError";
    this.rule = rule;
    this.hint = hint;
  }
}

export interface TxEvaluationRequest {
  account: Address;
  to?: Address | null;
  value?: bigint;
  data?: Hex;
  context: SignerContext;
}

export interface TypedDataEvaluationRequest {
  account: Address;
  parameters: unknown;
  context: SignerContext;
}

function parseMode(value?: string): PolicyMode | undefined {
  return value === "enforce" || value === "warn" || value === "off" ? value : undefined;
}

function defaultPolicy(): PolicyConfig {
  return {
    mode: "enforce",
    maxMintEth: "0.01",
    maxSwapEth: "0.02",
    maxEthTransferEth: "0.05",
    x402: {
      maxPerRequestUsdc: Number(process.env.APOW_X402_MAX_PER_REQUEST_USDC ?? "1"),
      dailyUsdc: Number(process.env.APOW_X402_DAILY_USDC ?? "20"),
      payees: [],
    },
    sweep: {
      auto: true,
      thresholdAgent: process.env.APOW_SWEEP_THRESHOLD_AGENT ?? "25",
    },
  };
}

function sanitizePolicy(raw: Partial<PolicyConfig>): PolicyConfig {
  const base = defaultPolicy();
  const payout = process.env.APOW_PAYOUT_ADDRESS?.trim() || raw.payout;
  return {
    ...base,
    ...raw,
    mode: parseMode(process.env.APOW_POLICY) ?? parseMode(raw.mode) ?? base.mode,
    payout: payout && /^0x[0-9a-fA-F]{40}$/.test(payout) ? getAddress(payout) as Address : undefined,
    x402: {
      ...base.x402,
      ...(raw.x402 ?? {}),
      maxPerRequestUsdc: Number(process.env.APOW_X402_MAX_PER_REQUEST_USDC ?? raw.x402?.maxPerRequestUsdc ?? base.x402.maxPerRequestUsdc),
      dailyUsdc: Number(process.env.APOW_X402_DAILY_USDC ?? raw.x402?.dailyUsdc ?? base.x402.dailyUsdc),
      payees: (raw.x402?.payees ?? []).filter((p): p is Address => /^0x[0-9a-fA-F]{40}$/.test(p)),
    },
    sweep: {
      ...base.sweep,
      ...(raw.sweep ?? {}),
      thresholdAgent: process.env.APOW_SWEEP_THRESHOLD_AGENT ?? raw.sweep?.thresholdAgent ?? base.sweep.thresholdAgent,
    },
  };
}

export function loadPolicy(): PolicyConfig {
  const path = policyPath();
  if (!existsSync(path)) return sanitizePolicy({});
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PolicyConfig>;
  return sanitizePolicy(raw);
}

export function validateEasyModePolicyCaps(policy: PolicyConfig): string | null {
  if (policy.mode !== "enforce") {
    return "Easy Mode requires the wallet signing policy in enforce mode.";
  }

  let maxMint: bigint;
  try {
    maxMint = parseEther(policy.maxMintEth);
  } catch {
    return "The policy mint cap is invalid.";
  }
  if (maxMint < 0n || maxMint > parseEther(EASY_MODE_POLICY_CAPS.maxMintEth)) {
    return `The policy mint cap must not exceed ${EASY_MODE_POLICY_CAPS.maxMintEth} ETH.`;
  }

  const perRequest = policy.x402.maxPerRequestUsdc;
  const daily = policy.x402.dailyUsdc;
  if (!Number.isFinite(perRequest) || perRequest < 0 || perRequest > EASY_MODE_POLICY_CAPS.maxPerRequestUsdc) {
    return `The x402 per-request cap must be between 0 and ${EASY_MODE_POLICY_CAPS.maxPerRequestUsdc} USDC.`;
  }
  if (!Number.isFinite(daily) || daily < 0 || daily > EASY_MODE_POLICY_CAPS.dailyUsdc) {
    return `The x402 daily cap must be between 0 and ${EASY_MODE_POLICY_CAPS.dailyUsdc} USDC.`;
  }
  return null;
}

export function writeDefaultPolicyFile(overwrite = false): string {
  const path = policyPath();
  if (existsSync(path) && !overwrite) return path;
  writeFileSync(path, JSON.stringify(defaultPolicy(), null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort.
  }
  return path;
}

export function savePolicy(policy: PolicyConfig): string {
  const path = policyPath();
  writeFileSync(path, JSON.stringify(policy, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort.
  }
  return path;
}

function lower(value?: Address | null): string {
  return (value ?? "").toLowerCase();
}

function finalize(policy: PolicyConfig, verdict: Verdict): Verdict {
  if (policy.mode === "off" && verdict.verdict === "deny") {
    return { ...verdict, verdict: "warn", rule: `${verdict.rule}: policy off` };
  }
  if (policy.mode === "warn" && verdict.verdict === "deny") {
    return { ...verdict, verdict: "warn" };
  }
  return verdict;
}

function deny(policy: PolicyConfig, rule: string, hint: string, kind: Verdict["kind"] = "other"): Verdict {
  return finalize(policy, { verdict: "deny", rule, hint, kind });
}

function allow(policy: PolicyConfig, rule: string, kind: Verdict["kind"], extra: Partial<Verdict> = {}): Verdict {
  return finalize(policy, { verdict: "allow", rule, kind, ...extra });
}

export function assertAllowed(verdict: Verdict): void {
  if (verdict.verdict === "deny") {
    throw new PolicyDeniedError(verdict.rule, verdict.hint ?? "Change policy.json or the command inputs.");
  }
}

export function evaluateTx(req: TxEvaluationRequest): Verdict {
  const policy = loadPolicy();
  const to = req.to ? getAddress(req.to) as Address : undefined;
  const value = req.value ?? 0n;
  const data = req.data ?? "0x";
  const selector = calldataSelector(data);

  if (!to) {
    return deny(policy, "contract creation not allowed", "APoW CLI never needs to deploy contracts.");
  }

  if (data === "0x") {
    if ((req.context === "sweep" || req.context === "wallet-fund") && value <= parseEther(policy.maxEthTransferEth)) {
      return allow(policy, "eth-transfer-cap", "eth-send");
    }
    if (req.context === "sweep" && policy.payout && lower(to) === lower(policy.payout)) {
      return allow(policy, "eth-sweep-to-payout", "sweep");
    }
    return deny(policy, "eth-transfer-denied", `Plain ETH transfers are capped at ${policy.maxEthTransferEth} ETH.`);
  }

  if (lower(to) === lower(config.agentCoinAddress) && selector === SELECTORS.mine && value === 0n) {
    return allow(policy, "agentcoin-mine", "mine");
  }

  if (lower(to) === lower(config.miningAgentAddress) && selector === SELECTORS.getChallenge && value === 0n) {
    return allow(policy, "miningagent-getchallenge", "challenge");
  }

  if (lower(to) === lower(config.miningAgentAddress) && selector === SELECTORS.mint && value <= parseEther(policy.maxMintEth)) {
    return allow(policy, "miningagent-mint", "mint");
  }

  const transfer = parseErc20Transfer(data);
  if (transfer && policy.payout && lower(transfer.recipient) === lower(policy.payout)) {
    if (lower(to) === lower(config.agentCoinAddress)) {
      return allow(policy, "agent-sweep-to-payout", "sweep");
    }
    if (lower(to) === lower(USDC_ADDRESS) && req.context === "sweep") {
      return allow(policy, "usdc-sweep-to-payout", "sweep");
    }
  }

  const approve = parseErc20Approve(data);
  if (approve && lower(to) === lower(USDC_ADDRESS) && lower(approve.spender) === lower(SWAP_ROUTER02) && req.context === "fund") {
    return allow(policy, "usdc-approve-swaprouter", "fund-swap");
  }

  if (lower(to) === lower(SWAP_ROUTER02) && req.context === "fund" && value <= parseEther(policy.maxSwapEth)) {
    if (selector === SELECTORS.exactInputSingle || selector === SELECTORS.multicall) {
      return allow(policy, "swaprouter-fund", "fund-swap");
    }
  }

  return deny(policy, `unknown-call-${selector}`, "Only APoW mining, minting, configured sweeps, and bounded funding swaps are allowed.");
}

export function evaluateTypedData(req: TypedDataEvaluationRequest): Verdict {
  const policy = loadPolicy();
  if (isPermitTypedData(req.parameters)) {
    return deny(policy, "permit-typed-data-denied", "Permit and Permit2 signatures are disabled.");
  }
  const payment = parseEip3009(req.parameters);
  if (!payment) {
    return deny(policy, "typed-data-denied", "Only USDC EIP-3009 x402 payment signatures are allowed.");
  }
  if (payment.usdc > policy.x402.maxPerRequestUsdc) {
    return deny(policy, "x402-per-request-cap", `Payment ${payment.usdc} USDC exceeds ${policy.x402.maxPerRequestUsdc} USDC.`);
  }
  const spent = spentTodayUsdc(req.account);
  if (spent + payment.usdc > policy.x402.dailyUsdc) {
    return deny(policy, "x402-daily-cap", `Daily x402 budget would exceed ${policy.x402.dailyUsdc} USDC.`);
  }
  if (policy.x402.payees.length > 0 && !policy.x402.payees.some((p) => lower(p) === lower(payment.payee))) {
    return deny(policy, "x402-payee-denied", "This x402 payee is not pinned in policy.json.");
  }
  return allow(policy, "x402-eip3009", "x402", { payee: payment.payee, usdc: payment.usdc });
}

export function getPayoutAddress(policy = loadPolicy()): Address | undefined {
  return policy.payout;
}
