// Fund command — unified funding for mining on Base.
// Accepts deposits in 6 forms across 3 chains, auto-bridges to Base,
// auto-splits into ETH (gas) + USDC (x402 RPC).
//
// Deposit types:
//   1. Solana SOL     → bridge → ETH on Base → swap portion to USDC
//   2. Solana USDC    → bridge → USDC on Base → swap portion to ETH
//   3. Ethereum ETH   → bridge → ETH on Base → swap portion to USDC
//   4. Ethereum USDC  → bridge → USDC on Base → swap portion to ETH
//   5. Base ETH       → (already there) → swap portion to USDC
//   6. Base USDC      → (already there) → swap portion to ETH

import type { Hex } from "viem";
import { formatEther, formatUnits, parseEther, parseUnits } from "viem";

import {
  type BaseAsset,
  type SourceChain,
  type SourceToken,
  bridgeOutputAsset,
  MIN_ETH,
  MIN_USDC,
  SLIPPAGE_BPS,
  TOKENS,
} from "./bridge/constants";
import { ROUTES, bridgeFromSolana, bridgeFromEvm, pollOrderStatus } from "./bridge/debridge";
import { SQUID_ROUTES, getDepositAddress, pollBridgeStatus } from "./bridge/squid";
import { getUsdcBalance, swapEthToUsdc, swapUsdcToEth } from "./bridge/uniswap";
import { account, getEthBalance } from "./wallet";
import { config } from "./config";
import * as ui from "./ui";

export interface FundOptions {
  chain?: string;
  token?: string;
  key?: string;
  amount?: string;
  swap?: boolean; // commander uses --no-swap which produces swap=false
}

// ---------------------------------------------------------------------------
// Price estimation
// ---------------------------------------------------------------------------

interface PriceInfo {
  solPerEth: number;
  ethPriceUsd: number;
  solPriceUsd: number;
}

async function fetchPrices(): Promise<PriceInfo> {
  const res = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=solana,ethereum&vs_currencies=usd",
  );
  if (!res.ok) throw new Error("Failed to fetch prices from CoinGecko");
  const data = (await res.json()) as any;
  const ethUsd: number = data.ethereum.usd;
  const solUsd: number = data.solana.usd;
  return { solPerEth: ethUsd / solUsd, ethPriceUsd: ethUsd, solPriceUsd: solUsd };
}

/** Source token amount needed for target ETH worth, with 10% buffer. */
function amountNeededForEth(targetEth: number, tokenPriceUsd: number, ethPriceUsd: number): number {
  return (targetEth * ethPriceUsd / tokenPriceUsd) * 1.1;
}

// ---------------------------------------------------------------------------
// QR code helper
// ---------------------------------------------------------------------------

async function showQrCode(text: string): Promise<void> {
  try {
    const mod = await import("qrcode-terminal");
    const qrcode = (mod as any).default || mod;
    await new Promise<void>((resolve) => {
      qrcode.generate(text, { small: true }, (qr: string) => {
        for (const line of qr.split("\n")) {
          if (line) console.log(`    ${line}`);
        }
        resolve();
      });
    });
  } catch {
    // QR is nice-to-have, not critical
  }
}

// ---------------------------------------------------------------------------
// Auto-split: ensure both ETH and USDC minimums are met
// ---------------------------------------------------------------------------

async function autoSplit(
  depositedAsset: BaseAsset,
  prices: PriceInfo,
  noSwap: boolean,
): Promise<void> {
  if (noSwap) return;
  if (!account) return;

  const ethBal = Number(formatEther(await getEthBalance()));
  const usdcBal = Number(formatUnits(await getUsdcBalance(account.address), 6));

  // Already good
  if (ethBal >= MIN_ETH && usdcBal >= MIN_USDC) {
    return;
  }

  // Not enough to cover anything useful
  const totalUsd = ethBal * prices.ethPriceUsd + usdcBal;
  const minTotalUsd = MIN_ETH * prices.ethPriceUsd + MIN_USDC;
  if (totalUsd < minTotalUsd * 0.5) {
    ui.warn("Balance too low for auto-split. Fund more to cover both ETH (gas) and USDC (x402 RPC).");
    return;
  }

  if (depositedAsset === "eth" && usdcBal < MIN_USDC) {
    const usdcNeeded = MIN_USDC - usdcBal;
    const ethToSwap = (usdcNeeded / prices.ethPriceUsd) * 1.02; // 2% buffer

    if (ethBal - ethToSwap < MIN_ETH * 0.5) {
      ui.warn("Not enough ETH to swap for USDC and keep enough for gas. Skipping auto-split.");
      return;
    }

    console.log("");
    ui.table([
      ["Auto-split", `Swap ~${ethToSwap.toFixed(6)} ETH → ~${usdcNeeded.toFixed(2)} USDC`],
      ["Purpose", "USDC for x402 RPC calls"],
      ["Remaining ETH", `~${(ethBal - ethToSwap).toFixed(6)} ETH (gas)`],
    ]);
    console.log("");

    const proceed = await ui.confirm("Confirm swap?");
    if (!proceed) {
      console.log("  Skipped auto-split.");
      return;
    }

    const swapSpinner = ui.spinner("Swapping ETH → USDC on Uniswap V3...");
    const ethWei = parseEther(ethToSwap.toFixed(18));
    const minUsdc = parseUnits(
      (usdcNeeded * (1 - SLIPPAGE_BPS / 10000)).toFixed(6),
      6,
    );

    try {
      const result = await swapEthToUsdc(ethWei, minUsdc);
      swapSpinner.stop(`Swap complete: ${result.usdcReceived} USDC`);
    } catch (err) {
      swapSpinner.fail("Swap failed");
      throw err;
    }
  }

  if (depositedAsset === "usdc" && ethBal < MIN_ETH) {
    const ethNeeded = MIN_ETH - ethBal;
    const usdcToSwap = ethNeeded * prices.ethPriceUsd * 1.02; // 2% buffer

    if (usdcBal - usdcToSwap < MIN_USDC * 0.5) {
      ui.warn("Not enough USDC to swap for ETH and keep enough for RPC. Skipping auto-split.");
      return;
    }

    console.log("");
    ui.table([
      ["Auto-split", `Swap ~${usdcToSwap.toFixed(2)} USDC → ~${ethNeeded.toFixed(6)} ETH`],
      ["Purpose", "ETH for gas"],
      ["Remaining USDC", `~${(usdcBal - usdcToSwap).toFixed(2)} USDC (x402 RPC)`],
    ]);
    console.log("");

    const proceed = await ui.confirm("Confirm swap?");
    if (!proceed) {
      console.log("  Skipped auto-split.");
      return;
    }

    const swapSpinner = ui.spinner("Swapping USDC → ETH on Uniswap V3...");
    const usdcRaw = parseUnits(usdcToSwap.toFixed(6), 6);
    const minEth = parseEther(
      (ethNeeded * (1 - SLIPPAGE_BPS / 10000)).toFixed(18),
    );

    try {
      const result = await swapUsdcToEth(usdcRaw, minEth);
      swapSpinner.stop(`Swap complete: ${result.ethReceived} ETH`);
    } catch (err) {
      swapSpinner.fail("Swap failed");
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Show final balances
// ---------------------------------------------------------------------------

async function showFinalBalances(): Promise<void> {
  if (!account) return;

  const ethBal = Number(formatEther(await getEthBalance()));
  const usdcBal = Number(formatUnits(await getUsdcBalance(account.address), 6));

  console.log("");
  console.log(`  ${ui.green("Ready to mine!")}`);
  ui.table([
    ["ETH", `${ethBal.toFixed(6)} ETH (gas)`],
    ["USDC", `${usdcBal.toFixed(2)} USDC (x402 RPC)`],
  ]);
  console.log(`  Next: ${ui.cyan("apow mint")}`);
  console.log("");
}

// ---------------------------------------------------------------------------
// Solana direct bridge (deBridge DLN)
// ---------------------------------------------------------------------------

async function runSolanaDirectBridge(
  solanaKeyInput: string,
  baseAddress: string,
  sourceToken: SourceToken,
  targetEth: number,
): Promise<void> {
  const solanaSpinner = ui.spinner("Checking Solana balance...");

  const solana = await import("./bridge/solana");

  let kp: { keypair: any; publicKey: string };
  try {
    kp = await solana.parseSolanaKey(solanaKeyInput);
  } catch (err) {
    solanaSpinner.fail("Invalid Solana key");
    throw err;
  }

  if (sourceToken === "usdc") {
    const usdcBal = await solana.getSplTokenBalance(kp.publicKey, TOKENS.solana.usdc);
    solanaSpinner.stop(`Solana USDC balance: ${usdcBal.toFixed(2)} USDC`);

    const priceSpinner = ui.spinner("Fetching prices...");
    const prices = await fetchPrices();
    priceSpinner.stop(`ETH price: $${prices.ethPriceUsd.toFixed(0)}`);

    const usdcAmount = targetEth * prices.ethPriceUsd * 1.1; // 10% buffer
    if (usdcBal < usdcAmount) {
      ui.error(`Insufficient USDC. Need ~${usdcAmount.toFixed(2)} USDC, have ${usdcBal.toFixed(2)} USDC.`);
      return;
    }

    console.log("");
    ui.table([
      ["Bridging", `${usdcAmount.toFixed(2)} USDC → USDC on Base`],
      ["Via", "deBridge DLN (~20 seconds)"],
      ["From", `${kp.publicKey.slice(0, 4)}...${kp.publicKey.slice(-4)}`],
      ["To", `${baseAddress.slice(0, 6)}...${baseAddress.slice(-4)}`],
    ]);
    console.log("");

    const proceed = await ui.confirm("Confirm bridge?");
    if (!proceed) { console.log("  Cancelled."); return; }

    const bridgeSpinner = ui.spinner("Signing bridge transaction...");
    const result = await bridgeFromSolana(kp.keypair, baseAddress, usdcAmount, ROUTES.sol_usdc_to_base_usdc);
    bridgeSpinner.stop(`Submitted! Order: ${result.orderId.slice(0, 12)}...`);

    const pollSpinner = ui.spinner("Waiting for bridge fulfillment... (~20s)");
    const fulfillment = await pollOrderStatus(result.orderId, (s) => pollSpinner.update(`Bridge status: ${s}`));
    pollSpinner.stop("Bridge complete! USDC arrived on Base");

    await autoSplit("usdc", prices, false);
    await showFinalBalances();
  } else {
    // SOL → ETH
    const balance = await solana.getSolanaBalance(kp.publicKey);
    solanaSpinner.stop(`Solana balance: ${balance.toFixed(4)} SOL`);

    const priceSpinner = ui.spinner("Fetching prices...");
    const prices = await fetchPrices();
    const solAmount = amountNeededForEth(targetEth, prices.solPriceUsd, prices.ethPriceUsd);
    priceSpinner.stop(`SOL/ETH rate: ${prices.solPerEth.toFixed(1)} SOL = 1 ETH`);

    if (balance < solAmount) {
      ui.error(`Insufficient SOL. Need ~${solAmount.toFixed(4)} SOL, have ${balance.toFixed(4)} SOL.`);
      return;
    }

    console.log("");
    ui.table([
      ["Bridging", `${solAmount.toFixed(4)} SOL → ~${targetEth.toFixed(4)} ETH on Base`],
      ["Via", "deBridge DLN (~20 seconds)"],
      ["From", `${kp.publicKey.slice(0, 4)}...${kp.publicKey.slice(-4)}`],
      ["To", `${baseAddress.slice(0, 6)}...${baseAddress.slice(-4)}`],
    ]);
    console.log("");

    const proceed = await ui.confirm("Confirm bridge?");
    if (!proceed) { console.log("  Cancelled."); return; }

    const bridgeSpinner = ui.spinner("Signing bridge transaction...");
    const result = await bridgeFromSolana(kp.keypair, baseAddress, solAmount, ROUTES.sol_to_eth);
    bridgeSpinner.stop(`Submitted! Order: ${result.orderId.slice(0, 12)}...`);

    const pollSpinner = ui.spinner("Waiting for bridge fulfillment... (~20s)");
    const fulfillment = await pollOrderStatus(result.orderId, (s) => pollSpinner.update(`Bridge status: ${s}`));
    const received = fulfillment.received
      ? (Number(fulfillment.received) / 1e18).toFixed(6)
      : `~${targetEth.toFixed(4)}`;
    pollSpinner.stop(`Bridge complete! ${received} ETH arrived on Base`);

    await autoSplit("eth", prices, false);
    await showFinalBalances();
  }
}

// ---------------------------------------------------------------------------
// Solana deposit address bridge (Squid Router)
// ---------------------------------------------------------------------------

async function runSolanaDepositBridge(
  baseAddress: string,
  sourceToken: SourceToken,
  targetEth: number,
): Promise<void> {
  const priceSpinner = ui.spinner("Fetching prices...");
  const prices = await fetchPrices();
  priceSpinner.stop(`ETH price: $${prices.ethPriceUsd.toFixed(0)}`);

  const route = sourceToken === "usdc"
    ? SQUID_ROUTES.sol_usdc_to_base_usdc
    : SQUID_ROUTES.sol_to_eth;

  const amount = sourceToken === "usdc"
    ? targetEth * prices.ethPriceUsd * 1.1
    : amountNeededForEth(targetEth, prices.solPriceUsd, prices.ethPriceUsd);

  const tokenLabel = sourceToken === "usdc" ? "USDC" : "SOL";

  const addrSpinner = ui.spinner("Generating deposit address...");
  const squid = await import("./bridge/squid");
  const solana = await import("./bridge/solana");

  let deposit: Awaited<ReturnType<typeof squid.getDepositAddress>>;
  try {
    deposit = await squid.getDepositAddress(baseAddress, amount, route);
  } catch (err) {
    addrSpinner.fail("Failed to get deposit address");
    throw err;
  }
  addrSpinner.stop("Deposit address ready");

  console.log("");
  console.log(`  ${ui.bold(`Send ${tokenLabel} to this address:`)}`);
  console.log("");
  console.log(`  ${ui.cyan(deposit.depositAddress)}`);
  console.log("");

  await showQrCode(deposit.depositAddress);

  console.log("");
  ui.table([
    ["Amount", `~${amount.toFixed(sourceToken === "usdc" ? 2 : 4)} ${tokenLabel}`],
    ["You'll receive", `~${deposit.expectedReceive} ${sourceToken === "usdc" ? "USDC" : "ETH"} on Base`],
    ["Bridge", "Squid Router (Chainflip)"],
    ["Time", "~1-3 minutes"],
  ]);
  console.log("");

  if (deposit.expiresAt) {
    ui.warn(`Deposit address expires: ${deposit.expiresAt}`);
    console.log("");
  }

  // Poll for deposit
  const depositSpinner = ui.spinner(`Waiting for ${tokenLabel} deposit... (Ctrl+C to cancel)`);

  if (sourceToken === "native") {
    // SOL deposit: poll Solana balance
    const initialBalance = await solana.getAddressBalance(deposit.depositAddress);
    let depositDetected = false;
    const depositDeadline = Date.now() + 600_000;

    while (!depositDetected && Date.now() < depositDeadline) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const currentBalance = await solana.getAddressBalance(deposit.depositAddress);
        if (currentBalance > initialBalance + 0.001) {
          depositDetected = true;
          depositSpinner.stop(`Deposit received! ${(currentBalance - initialBalance).toFixed(4)} SOL`);
        }
      } catch {
        // Transient RPC error
      }
    }

    if (!depositDetected) {
      depositSpinner.fail(`No ${tokenLabel} deposit detected after 10 minutes`);
      ui.hint("If you sent tokens, check: https://explorer.squidrouter.com");
      return;
    }
  } else {
    // USDC deposit: poll SPL token balance at the deposit address
    let depositDetected = false;
    const depositDeadline = Date.now() + 600_000;

    while (!depositDetected && Date.now() < depositDeadline) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const bal = await solana.getSplTokenBalance(deposit.depositAddress, TOKENS.solana.usdc);
        if (bal > 0.01) {
          depositDetected = true;
          depositSpinner.stop(`Deposit received! ${bal.toFixed(2)} USDC`);
        }
      } catch {
        // Transient RPC error
      }
    }

    if (!depositDetected) {
      depositSpinner.fail("No USDC deposit detected after 10 minutes");
      ui.hint("If you sent USDC, check: https://explorer.squidrouter.com");
      return;
    }
  }

  // Poll for bridge completion
  const bridgeSpinner = ui.spinner("Bridging to Base... (~1-3 min)");
  const result = await pollBridgeStatus(
    deposit.requestId,
    route.dstDecimals,
    (status) => bridgeSpinner.update(`Bridge status: ${status}`),
  );

  const received = result.received || deposit.expectedReceive;
  const receivedAsset = sourceToken === "usdc" ? "USDC" : "ETH";
  bridgeSpinner.stop(`Bridge complete! ${received} ${receivedAsset} arrived`);

  const outputAsset = bridgeOutputAsset(sourceToken);
  await autoSplit(outputAsset, prices, false);
  await showFinalBalances();
}

// ---------------------------------------------------------------------------
// Ethereum direct bridge (deBridge DLN)
// ---------------------------------------------------------------------------

async function runEthereumDirectBridge(
  baseAddress: string,
  sourceToken: SourceToken,
  targetEth: number,
): Promise<void> {
  if (!config.privateKey) {
    ui.error("No PRIVATE_KEY configured. Your wallet key is used on Ethereum mainnet too.");
    return;
  }

  const priceSpinner = ui.spinner("Fetching prices...");
  const prices = await fetchPrices();
  priceSpinner.stop(`ETH price: $${prices.ethPriceUsd.toFixed(0)}`);

  const route = sourceToken === "usdc"
    ? ROUTES.eth_usdc_to_base_usdc
    : ROUTES.eth_to_base_eth;

  const amount = sourceToken === "usdc"
    ? targetEth * prices.ethPriceUsd * 1.1
    : targetEth * 1.1;

  const tokenLabel = sourceToken === "usdc" ? "USDC" : "ETH";
  const receivedLabel = sourceToken === "usdc" ? "USDC" : "ETH";

  console.log("");
  ui.table([
    ["Bridging", `${amount.toFixed(sourceToken === "usdc" ? 2 : 6)} ${tokenLabel} → ${receivedLabel} on Base`],
    ["Via", "deBridge DLN (~20 seconds)"],
    ["From", `Ethereum mainnet (${baseAddress.slice(0, 6)}...${baseAddress.slice(-4)})`],
    ["To", `Base (same address)`],
  ]);
  console.log("");

  const proceed = await ui.confirm("Confirm bridge?");
  if (!proceed) { console.log("  Cancelled."); return; }

  const bridgeSpinner = ui.spinner("Signing bridge transaction on Ethereum...");
  try {
    const result = await bridgeFromEvm(config.privateKey, baseAddress, amount, route);
    bridgeSpinner.stop(`Submitted! Order: ${result.orderId.slice(0, 12)}...`);

    const pollSpinner = ui.spinner("Waiting for bridge fulfillment... (~20s)");
    const fulfillment = await pollOrderStatus(result.orderId, (s) => pollSpinner.update(`Bridge status: ${s}`));
    pollSpinner.stop(`Bridge complete! ${receivedLabel} arrived on Base`);

    const outputAsset = bridgeOutputAsset(sourceToken);
    await autoSplit(outputAsset, prices, false);
    await showFinalBalances();
  } catch (err) {
    bridgeSpinner.fail("Bridge failed");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Ethereum deposit address bridge (Squid Router)
// ---------------------------------------------------------------------------

async function runEthereumDepositBridge(
  baseAddress: string,
  sourceToken: SourceToken,
  targetEth: number,
): Promise<void> {
  const priceSpinner = ui.spinner("Fetching prices...");
  const prices = await fetchPrices();
  priceSpinner.stop(`ETH price: $${prices.ethPriceUsd.toFixed(0)}`);

  const route = sourceToken === "usdc"
    ? SQUID_ROUTES.eth_usdc_to_base_usdc
    : SQUID_ROUTES.eth_to_base_eth;

  const amount = sourceToken === "usdc"
    ? targetEth * prices.ethPriceUsd * 1.1
    : targetEth * 1.1;

  const tokenLabel = sourceToken === "usdc" ? "USDC" : "ETH";

  const addrSpinner = ui.spinner("Generating deposit address...");
  const squid = await import("./bridge/squid");

  let deposit: Awaited<ReturnType<typeof squid.getDepositAddress>>;
  try {
    deposit = await squid.getDepositAddress(baseAddress, amount, route);
  } catch (err) {
    addrSpinner.fail("Failed to get deposit address");
    throw err;
  }
  addrSpinner.stop("Deposit address ready");

  console.log("");
  console.log(`  ${ui.bold(`Send ${tokenLabel} on Ethereum mainnet to:`)}`);
  console.log("");
  console.log(`  ${ui.cyan(deposit.depositAddress)}`);
  console.log("");

  await showQrCode(deposit.depositAddress);

  console.log("");
  ui.table([
    ["Amount", `~${amount.toFixed(sourceToken === "usdc" ? 2 : 6)} ${tokenLabel}`],
    ["Network", "Ethereum mainnet"],
    ["You'll receive", `~${deposit.expectedReceive} ${sourceToken === "usdc" ? "USDC" : "ETH"} on Base`],
    ["Bridge", "Squid Router (Chainflip)"],
    ["Time", "~1-3 minutes"],
  ]);
  console.log("");

  if (deposit.expiresAt) {
    ui.warn(`Deposit address expires: ${deposit.expiresAt}`);
    console.log("");
  }

  // Wait for user to send manually — poll Squid status directly
  const bridgeSpinner = ui.spinner(`Send ${tokenLabel} and waiting for bridge... (Ctrl+C to cancel)`);

  // For Ethereum deposits, we rely on Squid status API rather than polling an RPC
  const result = await pollBridgeStatus(
    deposit.requestId,
    route.dstDecimals,
    (status) => bridgeSpinner.update(`Bridge status: ${status}`),
    900_000, // 15 min for Ethereum (slower block times)
  );

  const received = result.received || deposit.expectedReceive;
  const receivedAsset = sourceToken === "usdc" ? "USDC" : "ETH";
  bridgeSpinner.stop(`Bridge complete! ${received} ${receivedAsset} arrived`);

  const outputAsset = bridgeOutputAsset(sourceToken);
  await autoSplit(outputAsset, prices, false);
  await showFinalBalances();
}

// ---------------------------------------------------------------------------
// Base manual send (already on the right chain)
// ---------------------------------------------------------------------------

async function runBaseFund(
  baseAddress: string,
  sourceToken: SourceToken,
  noSwap: boolean,
): Promise<void> {
  const tokenLabel = sourceToken === "usdc" ? "USDC" : "ETH";

  console.log("");
  console.log(`  ${ui.bold(`Send ${tokenLabel} on Base to this address:`)}`);
  console.log("");
  console.log(`  ${ui.cyan(baseAddress)}`);
  console.log("");

  await showQrCode(baseAddress);

  console.log("");
  console.log(`  ${ui.dim("Send from any wallet — Coinbase, MetaMask, Phantom, etc.")}`);
  if (sourceToken === "usdc") {
    console.log(`  ${ui.dim("Need at least 2 USDC for x402 RPC + some for ETH swap.")}`);
  } else {
    console.log(`  ${ui.dim("Need ~0.005 ETH to cover gas + USDC swap.")}`);
  }
  console.log("");

  const waitForDeposit = await ui.confirm("Wait for deposit and auto-split?");
  if (!waitForDeposit) {
    console.log(`  ${ui.dim("After sending, run:")} ${ui.cyan("apow fund --chain base")} to auto-split.`);
    console.log("");
    return;
  }

  const prices = await fetchPrices();

  // Poll for balance change
  const depositSpinner = ui.spinner(`Waiting for ${tokenLabel} deposit... (Ctrl+C to cancel)`);
  const initialEth = await getEthBalance();
  const initialUsdc = account ? await getUsdcBalance(account.address) : 0n;
  const depositDeadline = Date.now() + 600_000;
  let depositDetected = false;

  while (!depositDetected && Date.now() < depositDeadline) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      if (sourceToken === "usdc" && account) {
        const currentUsdc = await getUsdcBalance(account.address);
        if (currentUsdc > initialUsdc + 100000n) { // > 0.1 USDC
          depositDetected = true;
          depositSpinner.stop(`Deposit received! ${formatUnits(currentUsdc - initialUsdc, 6)} USDC`);
        }
      } else {
        const currentEth = await getEthBalance();
        if (currentEth > initialEth + parseEther("0.0001")) {
          depositDetected = true;
          depositSpinner.stop(`Deposit received! ${formatEther(currentEth - initialEth)} ETH`);
        }
      }
    } catch {
      // Transient RPC error
    }
  }

  if (!depositDetected) {
    depositSpinner.fail(`No ${tokenLabel} deposit detected after 10 minutes`);
    return;
  }

  const outputAsset = bridgeOutputAsset(sourceToken);
  await autoSplit(outputAsset, prices, noSwap);
  await showFinalBalances();
}

// ---------------------------------------------------------------------------
// Interactive menus
// ---------------------------------------------------------------------------

async function selectSourceChain(): Promise<SourceChain> {
  console.log("  Where are your funds?");
  console.log(`    ${ui.cyan("1.")} Solana (SOL or USDC)`);
  console.log(`    ${ui.cyan("2.")} Ethereum mainnet (ETH or USDC)`);
  console.log(`    ${ui.cyan("3.")} Base (send ETH or USDC manually)`);
  console.log("");

  const choice = await ui.prompt("Choice", "1");
  switch (choice) {
    case "2": return "ethereum";
    case "3": return "base";
    default: return "solana";
  }
}

async function selectSourceToken(chain: SourceChain): Promise<SourceToken> {
  const nativeLabel = chain === "solana" ? "SOL" : "ETH";
  console.log("");
  console.log("  What token?");
  console.log(`    ${ui.cyan("1.")} ${nativeLabel}`);
  console.log(`    ${ui.cyan("2.")} USDC`);
  console.log("");

  const choice = await ui.prompt("Choice", "1");
  return choice === "2" ? "usdc" : "native";
}

function parseSourceChain(value?: string): SourceChain | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase();
  if (v === "solana" || v === "sol") return "solana";
  if (v === "ethereum" || v === "eth") return "ethereum";
  if (v === "base") return "base";
  return undefined;
}

function parseSourceToken(value?: string): SourceToken | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase();
  if (v === "sol" || v === "eth" || v === "native") return "native";
  if (v === "usdc") return "usdc";
  return undefined;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runFundFlow(options: FundOptions): Promise<void> {
  if (!account) {
    ui.error("No wallet configured. Run `apow setup` first.");
    process.exit(1);
  }

  const baseAddress = account.address;
  const ethBalance = Number(formatEther(await getEthBalance()));
  const usdcBalance = Number(formatUnits(await getUsdcBalance(baseAddress), 6));
  const noSwap = options.swap === false;

  console.log("");
  ui.banner(["Fund Your Mining Wallet"]);
  console.log("");

  ui.table([
    ["Wallet", `${baseAddress.slice(0, 6)}...${baseAddress.slice(-4)}`],
    ["ETH", `${ethBalance.toFixed(6)} ETH${ethBalance < MIN_ETH ? ` (need ≥${MIN_ETH} for gas)` : ""}`],
    ["USDC", `${usdcBalance.toFixed(2)} USDC${usdcBalance < MIN_USDC ? ` (need ≥${MIN_USDC} for x402 RPC)` : ""}`],
  ]);
  console.log("");

  // Already funded?
  if (ethBalance >= MIN_ETH && usdcBalance >= MIN_USDC) {
    console.log(`  ${ui.green("Already funded! Ready to mine.")}`);
    console.log(`  Next: ${ui.cyan("apow mint")}`);
    console.log("");

    // Allow explicit re-run if user wants to add more
    const addMore = await ui.confirm("Add more funds?");
    if (!addMore) return;
  }

  // Parse target ETH amount
  const targetEth = options.amount ? parseFloat(options.amount) : 0.005;
  if (isNaN(targetEth) || targetEth <= 0) {
    ui.error("Invalid amount. Specify ETH target (e.g., --amount 0.005).");
    return;
  }

  // Resolve source chain and token (from flags or interactive)
  let chain = parseSourceChain(options.chain);
  let token = parseSourceToken(options.token);

  if (!chain) {
    chain = await selectSourceChain();
  }

  if (!token) {
    token = await selectSourceToken(chain);
  }

  // Route to the appropriate flow
  switch (chain) {
    case "solana": {
      if (options.key) {
        await runSolanaDirectBridge(options.key, baseAddress, token, targetEth);
      } else {
        console.log("");
        console.log("  Bridge method:");
        console.log(`    ${ui.cyan("A.")} Direct signing (~20s, need Solana private key)`);
        console.log(`    ${ui.cyan("B.")} Deposit address (~1-3 min, send from any wallet)`);
        console.log("");

        const method = await ui.prompt("Choice", "A");
        if (method.toUpperCase() === "A") {
          const key = await ui.promptSecret("Solana private key (base58)");
          if (!key) { ui.error("No key provided."); return; }
          await runSolanaDirectBridge(key, baseAddress, token, targetEth);
        } else {
          await runSolanaDepositBridge(baseAddress, token, targetEth);
        }
      }
      break;
    }

    case "ethereum": {
      console.log("");
      console.log("  Bridge method:");
      console.log(`    ${ui.cyan("A.")} Direct signing (~20s, uses your PRIVATE_KEY on mainnet)`);
      console.log(`    ${ui.cyan("B.")} Deposit address (~1-3 min, send from any wallet)`);
      console.log("");

      const method = await ui.prompt("Choice", "A");
      if (method.toUpperCase() === "A") {
        await runEthereumDirectBridge(baseAddress, token, targetEth);
      } else {
        await runEthereumDepositBridge(baseAddress, token, targetEth);
      }
      break;
    }

    case "base": {
      await runBaseFund(baseAddress, token, noSwap);
      break;
    }
  }
}
