import type { Abi, Address } from "viem";
import { formatEther, formatUnits, parseEther, parseUnits } from "viem";

import agentCoinAbiJson from "./abi/AgentCoin.json";
import { TOKENS } from "./bridge/constants";
import { config } from "./config";
import { txUrl } from "./explorer";
import { createLpUnlockGate } from "./lp-gate";
import { setSignerContext } from "./policy/context";
import { getPayoutAddress, loadPolicy } from "./policy/policy";
import * as ui from "./ui";
import { publicClient, requireWallet } from "./wallet";

const agentCoinAbi = agentCoinAbiJson as Abi;
const ERC20_ABI = [
  { type: "function" as const, name: "balanceOf", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" as const },
  { type: "function" as const, name: "transfer", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable" as const },
] as const;
// lpDeployed is absent from the frozen AgentCoin.json ABI; declare it inline.
const LP_GATE_ABI = [
  { type: "function" as const, name: "lpDeployed", inputs: [], outputs: [{ name: "", type: "bool" }], stateMutability: "view" as const },
] as const;

const ETH_GAS_RESERVE = parseEther("0.0002");
const USDC_WORKING_BALANCE = parseUnits("5", 6);
const SWEEP_RECEIPT_TIMEOUT_MS = 30_000;
let nextAutoSweepMine = 0;
let autoSweepFailures = 0;
let lockNoticeShown = false;

const agentTransfersUnlocked = createLpUnlockGate(async () => {
  return (await publicClient.readContract({
    address: config.agentCoinAddress,
    abi: LP_GATE_ABI,
    functionName: "lpDeployed",
  })) as boolean;
});

export interface SweepOptions {
  all?: boolean;
  minAgent?: bigint;
  quiet?: boolean;
}

async function waitForReceipt(hash: `0x${string}`): Promise<void> {
  await Promise.race([
    publicClient.waitForTransactionReceipt({ hash }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Sweep receipt wait timed out")), SWEEP_RECEIPT_TIMEOUT_MS)),
  ]);
}

export async function runSweep(opts: SweepOptions = {}): Promise<boolean> {
  const policy = loadPolicy();
  const payout = getPayoutAddress(policy);
  const { account, walletClient } = requireWallet();
  if (!payout) {
    if (!opts.quiet) ui.warn("No payout address configured. Run `apow wallet payout set <address>`.");
    return false;
  }
  if (payout.toLowerCase() === account.address.toLowerCase()) {
    throw new Error("Payout address must be different from the mining wallet.");
  }

  setSignerContext("sweep");
  const minAgent = opts.minAgent ?? parseEther(policy.sweep.thresholdAgent);
  const agentBalance = (await publicClient.readContract({
    address: config.agentCoinAddress,
    abi: agentCoinAbi,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;

  let swept = false;
  let agentLocked = false;
  if (agentBalance >= minAgent) {
    if (await agentTransfersUnlocked()) {
      const hash = await walletClient.writeContract({
        address: config.agentCoinAddress,
        abi: ERC20_ABI,
        account,
        functionName: "transfer",
        args: [payout, agentBalance],
      });
      await waitForReceipt(hash);
      swept = true;
      if (!opts.quiet) {
        console.log(`  ${ui.green("Swept")} ${formatEther(agentBalance)} AGENT to ${payout.slice(0, 6)}...${payout.slice(-4)}`);
        console.log(`  Tx: ${ui.dim(txUrl(hash))}`);
      }
    } else {
      agentLocked = true;
      if (!opts.quiet) {
        console.log(`  ${ui.yellow("AGENT transfers are locked until the LP pool goes live.")}`);
        console.log(`  ${ui.dim(`${formatEther(agentBalance)} AGENT stays in the mining wallet; sweeps activate automatically at pool-live.`)}`);
      } else if (!lockNoticeShown) {
        lockNoticeShown = true;
        ui.hint(`Auto-sweep armed: mined AGENT sweeps to payout once the LP pool goes live (transfers are locked until then).`);
      }
    }
  }

  if (opts.all) {
    const eth = await publicClient.getBalance({ address: account.address });
    if (eth > ETH_GAS_RESERVE * 4n) {
      const value = eth - ETH_GAS_RESERVE * 4n;
      const hash = await walletClient.sendTransaction({ account, to: payout, value });
      await waitForReceipt(hash);
      swept = true;
      if (!opts.quiet) console.log(`  ${ui.green("Swept")} ${formatEther(value)} ETH`);
    }

    const usdcBalance = (await publicClient.readContract({
      address: TOKENS.base.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    })) as bigint;
    if (usdcBalance > USDC_WORKING_BALANCE) {
      const value = usdcBalance - USDC_WORKING_BALANCE;
      const hash = await walletClient.writeContract({
        address: TOKENS.base.usdc,
        abi: ERC20_ABI,
        account,
        functionName: "transfer",
        args: [payout as Address, value],
      });
      await waitForReceipt(hash);
      swept = true;
      if (!opts.quiet) console.log(`  ${ui.green("Swept")} ${formatUnits(value, 6)} USDC`);
    }
  }

  if (!swept && !agentLocked && !opts.quiet) {
    console.log(`  ${ui.dim(`Nothing to sweep. Unswept AGENT: ${formatEther(agentBalance)}`)}`);
  }
  return swept;
}

export async function maybeAutoSweep(mineCount: number): Promise<void> {
  const policy = loadPolicy();
  if (!policy.payout || !policy.sweep.auto || mineCount < nextAutoSweepMine) return;
  try {
    const swept = await runSweep({ quiet: true });
    if (swept) ui.ok("Auto-swept mined AGENT to payout address.");
    autoSweepFailures = 0;
  } catch (error) {
    autoSweepFailures += 1;
    nextAutoSweepMine = mineCount + 50;
    const message = error instanceof Error ? error.message : String(error);
    ui.warn(`Auto-sweep skipped: ${message}`);
  }
}

