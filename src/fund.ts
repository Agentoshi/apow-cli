// Fund command — bridge SOL → ETH on Base so Solana users can start mining.
// Three paths:
//   Option A: Direct Solana signing via deBridge DLN (~20s)
//   Option B: Deposit address + QR via Squid Router (~1-3 min)
//   Option C: Manual send (just show Base address)

import { formatEther } from "viem";

import { account, getEthBalance } from "./wallet";
import * as ui from "./ui";

export interface FundOptions {
  solana?: boolean;
  key?: string;
  amount?: string;
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

/** SOL needed for target ETH, with 10% buffer for bridge fees + slippage. */
function solNeededForEth(targetEth: number, solPerEth: number): number {
  return targetEth * solPerEth * 1.1;
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
// Option A — Direct signing via deBridge
// ---------------------------------------------------------------------------

async function runDirectBridge(
  solanaKeyInput: string,
  baseAddress: string,
  targetEth: number,
): Promise<void> {
  const solanaSpinner = ui.spinner("Checking Solana balance...");

  const solana = await import("./bridge/solana");
  const debridge = await import("./bridge/debridge");

  let kp: { keypair: any; publicKey: string };
  try {
    kp = await solana.parseSolanaKey(solanaKeyInput);
  } catch (err) {
    solanaSpinner.fail("Invalid Solana key");
    throw err;
  }

  const balance = await solana.getSolanaBalance(kp.publicKey);
  solanaSpinner.stop(`Solana balance: ${balance.toFixed(4)} SOL`);

  // Prices
  const priceSpinner = ui.spinner("Fetching prices...");
  const prices = await fetchPrices();
  const solAmount = solNeededForEth(targetEth, prices.solPerEth);
  priceSpinner.stop(`SOL/ETH rate: ${prices.solPerEth.toFixed(1)} SOL = 1 ETH`);

  if (balance < solAmount) {
    ui.error(
      `Insufficient SOL. Need ~${solAmount.toFixed(4)} SOL, have ${balance.toFixed(4)} SOL.`,
    );
    return;
  }

  console.log("");
  ui.table([
    ["Bridging", `${solAmount.toFixed(4)} SOL → ~${targetEth.toFixed(4)} ETH on Base`],
    ["Via", "deBridge DLN (~20 seconds)"],
    [
      "From",
      `${kp.publicKey.slice(0, 4)}...${kp.publicKey.slice(-4)}`,
    ],
    ["To", `${baseAddress.slice(0, 6)}...${baseAddress.slice(-4)}`],
  ]);
  console.log("");

  const proceed = await ui.confirm("Confirm bridge?");
  if (!proceed) {
    console.log("  Cancelled.");
    return;
  }

  const bridgeSpinner = ui.spinner("Signing bridge transaction...");
  const result = await debridge.bridgeViaDeBridge(
    kp.keypair,
    baseAddress,
    solAmount,
  );
  bridgeSpinner.stop(`Submitted! Order: ${result.orderId.slice(0, 12)}...`);

  const pollSpinner = ui.spinner("Waiting for bridge fulfillment... (~20s)");
  const fulfillment = await debridge.pollOrderStatus(
    result.orderId,
    (status) => pollSpinner.update(`Bridge status: ${status}`),
  );

  const received = fulfillment.ethReceived || `~${targetEth.toFixed(4)}`;
  pollSpinner.stop(`Bridge complete! ${received} ETH arrived on Base`);

  console.log("");
  console.log(
    `  ${ui.green("Your wallet is funded!")} Next: ${ui.cyan("apow mint")}`,
  );
  console.log("");
}

// ---------------------------------------------------------------------------
// Options B+C — Deposit address via Squid
// ---------------------------------------------------------------------------

async function runDepositBridge(
  baseAddress: string,
  targetEth: number,
): Promise<void> {
  const priceSpinner = ui.spinner("Fetching prices...");
  const prices = await fetchPrices();
  const solAmount = solNeededForEth(targetEth, prices.solPerEth);
  priceSpinner.stop(`SOL/ETH rate: ${prices.solPerEth.toFixed(1)} SOL = 1 ETH`);

  const addrSpinner = ui.spinner("Generating deposit address...");

  const squid = await import("./bridge/squid");
  const solana = await import("./bridge/solana");

  let deposit: Awaited<ReturnType<typeof squid.getDepositAddress>>;
  try {
    deposit = await squid.getDepositAddress(baseAddress, solAmount);
  } catch (err) {
    addrSpinner.fail("Failed to get deposit address");
    throw err;
  }
  addrSpinner.stop("Deposit address ready");

  // Display deposit info
  console.log("");
  console.log(`  ${ui.bold("Send SOL to this address:")}`);
  console.log("");
  console.log(`  ${ui.cyan(deposit.depositAddress)}`);
  console.log("");

  await showQrCode(deposit.depositAddress);

  console.log("");
  ui.table([
    [
      "Amount",
      `~${solAmount.toFixed(4)} SOL (~$${(solAmount * prices.solPriceUsd).toFixed(2)})`,
    ],
    ["You'll receive", `~${deposit.expectedReceive} ETH on Base`],
    ["Bridge", "Squid Router (Chainflip)"],
    ["Time", "~1-3 minutes"],
  ]);
  console.log("");

  if (deposit.expiresAt) {
    ui.warn(`Deposit address expires: ${deposit.expiresAt}`);
    console.log("");
  }

  // Poll for SOL deposit
  const depositSpinner = ui.spinner(
    "Waiting for SOL deposit... (Ctrl+C to cancel)",
  );

  const initialBalance = await solana.getAddressBalance(
    deposit.depositAddress,
  );
  let depositDetected = false;
  const depositDeadline = Date.now() + 600_000; // 10 min

  while (!depositDetected && Date.now() < depositDeadline) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const currentBalance = await solana.getAddressBalance(
        deposit.depositAddress,
      );
      if (currentBalance > initialBalance + 0.001) {
        depositDetected = true;
        depositSpinner.stop(
          `Deposit received! ${(currentBalance - initialBalance).toFixed(4)} SOL`,
        );
      }
    } catch {
      // Transient RPC error — keep polling
    }
  }

  if (!depositDetected) {
    depositSpinner.fail("No deposit detected after 10 minutes");
    ui.hint("If you sent SOL, check: https://explorer.squidrouter.com");
    return;
  }

  // Poll for bridge completion
  const bridgeSpinner = ui.spinner(
    "Bridging SOL → ETH on Base... (~1-3 min)",
  );
  const result = await squid.pollBridgeStatus(
    deposit.requestId,
    (status) => bridgeSpinner.update(`Bridge status: ${status}`),
  );

  const received = result.ethReceived || deposit.expectedReceive;
  bridgeSpinner.stop(`Bridge complete! ${received} ETH arrived`);

  console.log("");
  console.log(
    `  ${ui.green("Your wallet is funded!")} Next: ${ui.cyan("apow mint")}`,
  );
  console.log("");
}

// ---------------------------------------------------------------------------
// Option C — Manual Base address
// ---------------------------------------------------------------------------

async function runManualFund(baseAddress: string): Promise<void> {
  console.log("");
  console.log(`  ${ui.bold("Send ETH on Base to this address:")}`);
  console.log("");
  console.log(`  ${ui.cyan(baseAddress)}`);
  console.log("");

  await showQrCode(baseAddress);

  console.log("");
  console.log(
    `  ${ui.dim("Send from any wallet — Coinbase, MetaMask, Phantom, etc.")}`,
  );
  console.log(`  ${ui.dim("Need ~0.005 ETH to start mining.")}`);
  console.log(`  ${ui.dim("After sending, run:")} ${ui.cyan("apow mint")}`);
  console.log("");
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
  const balance = await getEthBalance();
  const ethBalance = Number(formatEther(balance));

  console.log("");
  ui.banner(["Fund Your Mining Wallet"]);
  console.log("");

  ui.table([
    [
      "Your Base wallet",
      `${baseAddress.slice(0, 6)}...${baseAddress.slice(-4)}`,
    ],
    [
      "Balance",
      `${ethBalance.toFixed(6)} ETH${ethBalance < 0.005 ? " (need ~0.005 ETH to start)" : ""}`,
    ],
  ]);
  console.log("");

  // Parse target ETH
  const targetEth = options.amount ? parseFloat(options.amount) : 0.005;
  if (isNaN(targetEth) || targetEth <= 0) {
    ui.error("Invalid amount. Specify ETH target (e.g., --amount 0.005).");
    return;
  }

  // --key flag: direct bridge immediately
  if (options.key) {
    await runDirectBridge(options.key, baseAddress, targetEth);
    return;
  }

  // --solana flag: ask about key, then bridge
  if (options.solana) {
    const hasKey = await ui.confirm("Do you have your Solana private key?");
    if (hasKey) {
      const key = await ui.promptSecret("Solana private key (base58)");
      if (!key) {
        ui.error("No key provided.");
        return;
      }
      await runDirectBridge(key, baseAddress, targetEth);
    } else {
      await runDepositBridge(baseAddress, targetEth);
    }
    return;
  }

  // Interactive menu
  console.log("  How do you want to fund?");
  console.log(
    `    ${ui.cyan("1.")} Bridge from Solana (SOL → ETH on Base)`,
  );
  console.log(
    `    ${ui.cyan("2.")} Send ETH on Base directly (from another wallet)`,
  );
  console.log(`    ${ui.cyan("3.")} Copy address and fund manually`);
  console.log("");

  const choice = await ui.prompt("Choice", "1");

  switch (choice) {
    case "1": {
      const hasKey = await ui.confirm("Do you have your Solana private key?");
      if (hasKey) {
        const key = await ui.promptSecret("Solana private key (base58)");
        if (!key) {
          ui.error("No key provided.");
          return;
        }
        await runDirectBridge(key, baseAddress, targetEth);
      } else {
        await runDepositBridge(baseAddress, targetEth);
      }
      break;
    }

    case "2": {
      console.log("");
      console.log(`  ${ui.bold("Send ETH on Base to:")}`);
      console.log(`  ${ui.cyan(baseAddress)}`);
      console.log("");
      console.log(`  ${ui.dim("Need ~0.005 ETH to start mining.")}`);
      console.log(
        `  ${ui.dim("After sending, run:")} ${ui.cyan("apow mint")}`,
      );
      console.log("");
      break;
    }

    case "3":
    default: {
      await runManualFund(baseAddress);
      break;
    }
  }
}
