import { formatEther, formatUnits, parseEther } from "viem";
import { account, getFundingClients } from "./wallet";
import { detectMinersWithClient } from "./detect";
import { prepareBaseFunding } from "./base-funding";
import { getDepositAddress, pollBridgeStatus, SQUID_ROUTES } from "./bridge/squid";
import { quoteEthSwapFees, quoteUsdcForEth, swapUsdcToEth } from "./bridge/uniswap";
import * as ui from "./ui";

export interface FundOptions {
  chain?: string;
  token?: string;
  amount?: string;
  swap?: boolean;
}

async function needsMint(): Promise<boolean> {
  if (!account) throw new Error("Unlock your existing mining wallet before funding");
  return (await detectMinersWithClient(getFundingClients().publicClient, account.address)).length === 0;
}

function handoff(address: string, amount: bigint): void {
  ui.hint(`Send at least ${formatEther(amount)} ETH on Base to ${address}.`);
  ui.hint("The quote includes the live rig price, ETH reserve, swap gas, and USDC service budget. You only send ETH.");
  ui.hint("After deposit, rerun apow start --easy to convert and resume with the same wallet.");
}

async function runBaseFund(mint: boolean, allowSwap: boolean): Promise<void> {
  let plan = await prepareBaseFunding(mint, allowSwap);
  if (plan.ready) {
    ui.ok(`Funding verified: ${formatEther(plan.balances.eth)} ETH and ${formatUnits(plan.balances.usdc, 6)} USDC.`);
    return;
  }
  if (plan.depositEth === 0n) {
    ui.hint("ETH is sufficient. Rerun without --no-swap to convert the service budget to USDC.");
    return;
  }
  handoff(account!.address, plan.depositEth);
  if (!ui.isInteractiveSession() || !await ui.confirm("Watch this address for up to 10 minutes and finish the conversion?")) return;
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5_000));
    plan = await prepareBaseFunding(mint, allowSwap);
    if (plan.ready) { ui.ok("Deposit and funding conversion verified. Run apow start --easy."); return; }
  }
  ui.warn("Funding is still incomplete. Keep the same wallet and rerun after deposit.");
}

/** Preserve the explicit legacy USDC route without asking for a second deposit asset. */
async function convertExistingUsdc(mint: boolean): Promise<void> {
  const plan = await prepareBaseFunding(mint, false);
  if (plan.balances.eth >= plan.requirements.ethReserve) return;
  const gas = 2n * (await quoteEthSwapFees(plan.swapEth || 1n, plan.requirements.usdcTarget || 1n)).feeReserve;
  if (plan.balances.eth < gas) return;
  const minimumEth = plan.requirements.ethReserve - plan.balances.eth + gas;
  const input = await quoteUsdcForEth(minimumEth);
  if (plan.balances.usdc < input + plan.requirements.usdcTarget) return;
  await swapUsdcToEth(input, minimumEth);
}

/** Quote a bridge before offering a deposit address; verify Base funds before mining. */
async function runBridgeFund(options: FundOptions, mint: boolean): Promise<void> {
  const chain = options.chain!.toLowerCase();
  const token = (options.token ?? (chain === "solana" ? "sol" : "eth")).toLowerCase();
  const route = chain === "solana"
    ? token === "usdc" ? SQUID_ROUTES.sol_usdc_to_base_eth : SQUID_ROUTES.sol_to_eth
    : SQUID_ROUTES.eth_to_base_eth;
  const plan = await prepareBaseFunding(mint, false);
  const target = options.amount ? parseEther(options.amount) : plan.depositEth;
  if (target <= 0n) { await runBaseFund(mint, options.swap !== false); return; }
  const needed = target > plan.depositEth ? target : plan.depositEth;
  // Prices only seed the source amount. The provider minimum must cover Base costs.
  const prices = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana,ethereum&vs_currencies=usd", {
    signal: AbortSignal.timeout(10_000),
  });
  if (!prices.ok) throw new Error("Could not price the bridge. No deposit address was issued.");
  const data = await prices.json() as { ethereum?: { usd: number }; solana?: { usd: number } };
  const ethUsd = data.ethereum?.usd;
  const sourceUsd = token === "usdc" ? 1 : chain === "solana" ? data.solana?.usd : ethUsd;
  if (!ethUsd || !sourceUsd || !Number.isFinite(ethUsd) || !Number.isFinite(sourceUsd) || ethUsd <= 0 || sourceUsd <= 0) {
    throw new Error("Invalid bridge price. No deposit address was issued.");
  }
  const amount = Number(formatEther(needed)) * ethUsd / sourceUsd * 1.15;
  const deposit = await getDepositAddress(account!.address, amount, route, needed);
  ui.hint(`Send ${amount.toFixed(route.srcDecimals)} ${chain === "solana" ? token.toUpperCase() : "ETH"} on ${chain} to ${deposit.depositAddress}.`);
  ui.hint(`Minimum receive: ${deposit.minimumReceive} ETH on Base. Keep request ${deposit.requestId} to recover this route.`);
  if (deposit.expiresAt) ui.hint(`Deposit address expires: ${deposit.expiresAt}. Do not reuse it after expiry.`);
  if (!ui.isInteractiveSession() || !await ui.confirm("Watch this bridge for up to 10 minutes?")) {
    ui.hint("After Base funds arrive, rerun apow start --easy; no second deposit asset is needed.");
    return;
  }
  await pollBridgeStatus(deposit.requestId);
  await runBaseFund(mint, options.swap !== false);
}

export async function runFundFlow(options: FundOptions): Promise<void> {
  if (!account) throw new Error("Unlock your existing mining wallet before funding");
  if (options.amount && (!/^\d+(\.\d{1,18})?$/.test(options.amount) || parseEther(options.amount) <= 0n)) {
    throw new Error("--amount must be a positive ETH target with at most 18 decimal places");
  }
  const chain = (options.chain ?? "base").toLowerCase();
  if (!["base", "solana", "ethereum"].includes(chain)) throw new Error("Source chain must be base, solana, or ethereum");
  const token = options.token?.toLowerCase();
  if (token && !(chain === "solana" ? ["sol", "usdc", "native"] : chain === "base" ? ["eth", "usdc", "native"] : ["eth", "native"]).includes(token)) {
    throw new Error("Use Base ETH, Solana SOL/USDC, or Ethereum ETH for single-asset funding");
  }
  const mint = await needsMint();
  if (chain === "base" && token === "usdc" && options.swap !== false) await convertExistingUsdc(mint);
  if (chain === "base") await runBaseFund(mint, options.swap !== false);
  else await runBridgeFund({ ...options, chain, token: token === "native" ? chain === "solana" ? "sol" : "eth" : token }, mint);
}
