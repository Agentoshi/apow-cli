#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Command } from "commander";

import type { Abi } from "viem";
import { formatEther, parseEther } from "viem";

import miningAgentAbiJson from "./abi/MiningAgent.json";
import { config, isExpensiveModel, writeEnvFile, type LlmProvider } from "./config";
import { detectMiners, formatHashpower, selectBestMiner } from "./detect";
import { txUrl } from "./explorer";
import { runFundFlow } from "./fund";
import { runMintFlow } from "./mint";
import { startMining } from "./miner";
import { runPreflight } from "./preflight";
import { displayStats } from "./stats";
import * as ui from "./ui";
import { account, getEthBalance, publicClient, requireWallet } from "./wallet";

const miningAgentAbi = miningAgentAbiJson as Abi;

function saveKeyFile(address: string, privateKey: string): string {
  const filename = `wallet-${address}.txt`;
  const filepath = join(process.cwd(), filename);
  const content = [
    `Address:     ${address}`,
    `Private Key: ${privateKey}`,
    ``,
    `Generated:   ${new Date().toISOString()}`,
    ``,
    `Import this key into MetaMask, Phantom, or any EVM wallet.`,
    `Keep this file safe — anyone with the private key controls your funds.`,
    "",
  ].join("\n");
  writeFileSync(filepath, content, { encoding: "utf8", mode: 0o600 });
  return filepath;
}

function parseTokenId(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new Error(`Invalid token ID: ${value}`);
  }
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

async function resolveTokenId(tokenIdArg?: string): Promise<bigint> {
  if (tokenIdArg) {
    return parseTokenId(tokenIdArg);
  }

  if (!account) {
    ui.error("No token ID provided and no wallet configured.");
    ui.hint("Usage: apow mine <tokenId> or configure PRIVATE_KEY in .env");
    process.exit(1);
  }

  const miners = await detectMiners(account.address);
  if (miners.length === 0) {
    ui.error("No mining rigs found for this wallet.");
    ui.hint("Run `apow mint` to mint a miner NFT first.");
    process.exit(1);
  }

  const best = selectBestMiner(miners);
  if (miners.length === 1) {
    console.log(`  Using miner #${best.tokenId} (${best.rarityLabel}, ${formatHashpower(best.hashpower)})`);
  } else {
    console.log(`  Found ${miners.length} miners — using #${best.tokenId} (${best.rarityLabel}, ${formatHashpower(best.hashpower)})`);
    for (const m of miners) {
      const marker = m.tokenId === best.tokenId ? ui.green(" *") : "  ";
      console.log(`  ${marker} #${m.tokenId} — ${m.rarityLabel} (${formatHashpower(m.hashpower)})`);
    }
  }

  return best.tokenId;
}

async function setupWizard(): Promise<void> {
  console.log("");
  ui.banner(["AgentCoin Miner Setup"]);
  console.log("");

  const values: Record<string, string> = {};

  // Step 1: Wallet
  console.log(`  ${ui.bold("Step 1/3: Wallet")}`);
  const hasWallet = await ui.confirm("Do you have a Base wallet?");

  let privateKey: string;
  let addr: string;

  if (hasWallet) {
    const inputKey = await ui.promptSecret("Private key (0x-prefixed)");
    if (!inputKey) {
      ui.error("Private key is required.");
      return;
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(inputKey)) {
      ui.error("Invalid private key format. Must be 0x + 64 hex characters.");
      return;
    }
    privateKey = inputKey;
    const { privateKeyToAccount } = await import("viem/accounts");
    const walletAccount = privateKeyToAccount(privateKey as `0x${string}`);
    addr = walletAccount.address;
  } else {
    const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
    privateKey = generatePrivateKey();
    const walletAccount = privateKeyToAccount(privateKey as `0x${string}`);
    addr = walletAccount.address;

    console.log("");
    console.log(`  ${ui.bold("NEW WALLET GENERATED")}`);
    console.log("");
    console.log(`  Address:     ${addr}`);
    console.log(`  Private Key: ${privateKey}`);
    console.log("");
    console.log(`  ${ui.yellow("⚠ SAVE YOUR PRIVATE KEY — this is the only time")}`);
    console.log(`  ${ui.yellow("  it will be displayed. Anyone with this key")}`);
    console.log(`  ${ui.yellow("  controls your funds.")}`);
    console.log("");
    console.log(`  ${ui.dim("Import into Phantom, MetaMask, or any EVM wallet")}`);
    console.log(`  ${ui.dim("to view your AGENT tokens and Mining Rig NFT.")}`);
    console.log("");
    console.log(`  ${ui.dim("Fund this address with ≥0.005 ETH on Base to start.")}`);
    console.log("");

    const keyPath = saveKeyFile(addr, privateKey);
    console.log(`  ${ui.dim(`Key saved to: ${keyPath}`)}`);
    console.log(`  ${ui.yellow("Back up this file securely, then delete it.")}`);
    console.log("");
  }

  values.PRIVATE_KEY = privateKey;
  ui.ok(`Wallet: ${addr.slice(0, 6)}...${addr.slice(-4)}`);
  console.log("");

  // Step 2: RPC
  console.log(`  ${ui.bold("Step 2/3: RPC")}`);
  const rpcUrl = await ui.prompt("Base RPC URL", "https://mainnet.base.org");
  values.RPC_URL = rpcUrl;

  // Validate RPC connectivity
  try {
    const { createPublicClient, http } = await import("viem");
    const { base, baseSepolia } = await import("viem/chains");
    const isSepolia = rpcUrl.toLowerCase().includes("sepolia");
    const testClient = createPublicClient({
      chain: isSepolia ? baseSepolia : base,
      transport: http(rpcUrl),
    });
    const blockNumber = await testClient.getBlockNumber();
    const networkName = isSepolia ? "Base Sepolia" : "Base mainnet";
    ui.ok(`Connected — ${networkName}, block #${blockNumber.toLocaleString()}`);
    if (isSepolia) values.CHAIN = "baseSepolia";
  } catch {
    ui.fail("Could not connect to RPC");
    ui.hint("Continuing anyway — you can fix RPC_URL in .env later");
  }
  console.log("");

  // Step 3: LLM
  console.log(`  ${ui.bold("Step 3/3: LLM Provider")}`);
  const providerInput = await ui.prompt("Provider (openai/anthropic/gemini/ollama/claude-code/codex)", "openai");
  const provider = (["openai", "anthropic", "gemini", "ollama", "claude-code", "codex"].includes(providerInput) ? providerInput : "openai") as LlmProvider;
  values.LLM_PROVIDER = provider;

  if (provider === "ollama") {
    const ollamaUrl = await ui.prompt("Ollama URL", "http://127.0.0.1:11434");
    values.OLLAMA_URL = ollamaUrl;
    ui.ok(`Ollama at ${ollamaUrl}`);
  } else if (provider === "claude-code" || provider === "codex") {
    ui.ok(`Using local ${provider} CLI — no API key needed`);
  } else {
    const apiKey = await ui.promptSecret("API key");
    if (apiKey) {
      values.LLM_API_KEY = apiKey;
      ui.ok(`${provider} key set`);
    } else {
      ui.fail("No API key provided");
      ui.hint(`Set LLM_API_KEY in .env later`);
    }
  }

  const defaultModel = provider === "gemini" ? "gemini-2.5-flash" : provider === "anthropic" ? "claude-sonnet-4-5-20250929" : provider === "claude-code" || provider === "codex" ? "default" : "gpt-4o-mini";
  const model = await ui.prompt("Model", defaultModel);
  values.LLM_MODEL = model;

  if (isExpensiveModel(model)) {
    ui.warn(`${model} is expensive. Consider gpt-4o-mini for lower cost.`);
  }

  // Contract addresses
  values.MINING_AGENT_ADDRESS = config.miningAgentAddress ?? "";
  values.AGENT_COIN_ADDRESS = config.agentCoinAddress ?? "";

  console.log("");

  // Check for existing .env
  const envPath = join(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const overwrite = await ui.confirm("Overwrite existing .env?");
    if (!overwrite) {
      console.log("  Setup cancelled.");
      return;
    }
  }

  await writeEnvFile(values);
  ui.ok("Config saved to .env");

  // Check .gitignore
  const gitignorePath = join(process.cwd(), ".gitignore");
  if (existsSync(gitignorePath)) {
    const gitignore = readFileSync(gitignorePath, "utf8");
    if (!gitignore.includes(".env")) {
      ui.warn(".gitignore does not include .env — your secrets may be committed!");
      ui.hint("Add .env and wallet-*.txt to .gitignore");
    }
    if (!gitignore.includes("wallet-")) {
      ui.hint("Consider adding wallet-*.txt to .gitignore");
    }
  }

  console.log("");
  console.log(`  Next: ${ui.cyan("apow mint")}`);
  console.log("");
}

async function main(): Promise<void> {
  const version = readVersion();
  const program = new Command();

  // SIGINT handler
  process.on("SIGINT", () => {
    ui.stopAll();
    console.log("");
    console.log(ui.dim("  Interrupted. Bye!"));
    process.exit(0);
  });

  program
    .name("apow")
    .description("Mine AGENT tokens on Base L2 with AI-powered proof of work")
    .version(version);

  program
    .command("setup")
    .description("Interactive setup wizard — configure wallet, RPC, and LLM")
    .action(async () => {
      await setupWizard();
    });

  program
    .command("fund")
    .description("Fund your wallet — bridge SOL → ETH on Base, or show deposit address")
    .option("--solana", "Bridge from Solana")
    .option("--key <base58>", "Solana private key for direct signing")
    .option("--amount <eth>", "Target ETH amount (default: 0.005)")
    .hook("preAction", async () => {
      await runPreflight("readonly");
    })
    .action(async (opts: { solana?: boolean; key?: string; amount?: string }) => {
      await runFundFlow(opts);
    });

  program
    .command("mint")
    .description("Mint a new miner NFT")
    .hook("preAction", async () => {
      await runPreflight("wallet");
    })
    .action(async () => {
      await runMintFlow();
    });

  program
    .command("mine")
    .description("Start the mining loop")
    .argument("[tokenId]", "Miner token ID (auto-detects if omitted)")
    .hook("preAction", async () => {
      await runPreflight("mining");
    })
    .action(async (tokenIdArg?: string) => {
      const tokenId = await resolveTokenId(tokenIdArg);
      await startMining(tokenId);
    });

  program
    .command("stats")
    .description("Show network and miner statistics")
    .argument("[tokenId]", "Miner token ID (auto-detects if omitted)")
    .hook("preAction", async () => {
      await runPreflight("readonly");
    })
    .action(async (tokenIdArg?: string) => {
      let tokenId: bigint | undefined;
      if (tokenIdArg) {
        tokenId = parseTokenId(tokenIdArg);
      } else if (account) {
        try {
          const miners = await detectMiners(account.address);
          if (miners.length > 0) {
            tokenId = selectBestMiner(miners).tokenId;
          }
        } catch {
          // No miners — show network stats only
        }
      }
      await displayStats(tokenId);
    });

  const walletCmd = program
    .command("wallet")
    .description("Wallet generation and management");

  walletCmd
    .command("new")
    .description("Generate a new Base wallet (prints key and saves to file)")
    .action(async () => {
      const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
      const key = generatePrivateKey();
      const acct = privateKeyToAccount(key);
      console.log("");
      console.log(`  ${ui.bold("NEW WALLET GENERATED")}`);
      console.log("");
      console.log(`  Address:     ${acct.address}`);
      console.log(`  Private Key: ${key}`);
      console.log("");
      console.log(`  ${ui.yellow("⚠ SAVE YOUR PRIVATE KEY — this is the only time")}`);
      console.log(`  ${ui.yellow("  it will be displayed. Anyone with this key")}`);
      console.log(`  ${ui.yellow("  controls your funds.")}`);
      console.log("");
      const keyPath = saveKeyFile(acct.address, key);
      console.log(`  ${ui.dim(`Key saved to: ${keyPath}`)}`);
      console.log(`  ${ui.yellow("Back up this file securely, then delete it.")}`);
      console.log("");
      console.log(`  ${ui.dim("Import into Phantom, MetaMask, or any EVM wallet")}`);
      console.log(`  ${ui.dim("to view your AGENT tokens and Mining Rig NFT.")}`);
      console.log("");
    });

  walletCmd
    .command("show")
    .description("Show wallet address from current .env PRIVATE_KEY")
    .action(async () => {
      if (!account) {
        ui.error("No wallet configured. Set PRIVATE_KEY in .env or run: apow wallet new");
        return;
      }
      console.log("");
      console.log(`  Address: ${account.address}`);
      console.log("");
    });

  walletCmd
    .command("export")
    .description("Export wallet private key (with confirmation)")
    .action(async () => {
      if (!account || !config.privateKey) {
        ui.error("No wallet configured. Set PRIVATE_KEY in .env or run: apow wallet new");
        return;
      }

      const proceed = await ui.confirm("This will display your private key. Continue?");
      if (!proceed) {
        console.log("  Cancelled.");
        return;
      }

      console.log("");
      console.log(`  Address:     ${account.address}`);
      console.log(`  Private Key: ${config.privateKey}`);
      console.log("");

      const filename = `wallet-${account.address}.txt`;
      const filepath = join(process.cwd(), filename);
      if (!existsSync(filepath)) {
        const save = await ui.confirm("Save to file?");
        if (save) {
          const keyPath = saveKeyFile(account.address, config.privateKey);
          console.log(`  ${ui.dim(`Saved to: ${keyPath}`)}`);
          console.log(`  ${ui.yellow("Back up this file securely, then delete it.")}`);
          console.log("");
        }
      }
    });

  walletCmd
    .command("fund")
    .description("Send ETH from your wallet to another address")
    .argument("<address>", "Destination address (0x-prefixed)")
    .argument("[amount]", "ETH amount to send (default: mint price + 0.003 ETH gas buffer)")
    .hook("preAction", async () => {
      await runPreflight("wallet");
    })
    .action(async (address: string, amountArg?: string) => {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
        ui.error("Invalid address format. Must be 0x + 40 hex characters.");
        return;
      }

      const { account: senderAccount, walletClient } = requireWallet();
      const destAddress = address as `0x${string}`;

      // Determine amount
      let amount: bigint;
      if (amountArg) {
        try {
          amount = parseEther(amountArg);
        } catch {
          ui.error(`Invalid amount: ${amountArg}. Use decimal ETH (e.g., 0.005).`);
          return;
        }
      } else {
        // Default: current mint price + 0.003 ETH gas buffer
        const mintPrice = (await publicClient.readContract({
          address: config.miningAgentAddress,
          abi: miningAgentAbi,
          functionName: "getMintPrice",
        })) as bigint;
        const gasBuffer = parseEther("0.003");
        amount = mintPrice + gasBuffer;
      }

      const senderBalance = await getEthBalance();

      console.log("");
      ui.table([
        ["From", `${senderAccount.address.slice(0, 6)}...${senderAccount.address.slice(-4)}`],
        ["To", `${destAddress.slice(0, 6)}...${destAddress.slice(-4)}`],
        ["Amount", `${formatEther(amount)} ETH`],
        ["Balance", `${Number(formatEther(senderBalance)).toFixed(6)} ETH`],
      ]);
      console.log("");

      if (senderBalance < amount) {
        ui.error("Insufficient ETH balance.");
        ui.hint(`Need ${formatEther(amount)} ETH, have ${Number(formatEther(senderBalance)).toFixed(6)} ETH`);
        return;
      }

      const proceed = await ui.confirm("Send ETH?");
      if (!proceed) {
        console.log("  Cancelled.");
        return;
      }

      const sendSpinner = ui.spinner("Sending ETH...");
      const txHash = await walletClient.sendTransaction({
        account: senderAccount,
        to: destAddress,
        value: amount,
      });
      sendSpinner.update("Waiting for confirmation...");
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status === "reverted") {
        sendSpinner.fail("Transaction reverted");
        return;
      }
      sendSpinner.stop("Sending ETH... confirmed");

      console.log(`  ${ui.green("Sent")} ${formatEther(amount)} ETH to ${destAddress.slice(0, 6)}...${destAddress.slice(-4)}`);
      console.log(`  Tx: ${ui.dim(txUrl(receipt.transactionHash))}`);
      console.log("");
    });

  // --- Dashboard commands ---
  const dashboardCmd = program
    .command("dashboard")
    .description("Multi-wallet mining dashboard");

  dashboardCmd
    .command("start", { isDefault: true })
    .description("Launch the dashboard web UI")
    .action(async () => {
      const walletsPath = getWalletsPath();

      // Seed wallets.json if it doesn't exist
      if (!existsSync(walletsPath)) {
        const walletsDir = join(process.env.HOME ?? "", ".apow");
        if (!existsSync(walletsDir)) mkdirSync(walletsDir, { recursive: true });
        const initial = account ? [account.address] : [];
        writeFileSync(walletsPath, JSON.stringify(initial, null, 2), "utf8");
        if (account) {
          ui.ok(`Seeded ${walletsPath} with ${account.address.slice(0, 6)}...${account.address.slice(-4)}`);
        } else {
          ui.ok(`Created ${walletsPath} (empty — add wallets with: apow dashboard add <address>)`);
        }
      }

      // Auto-detect wallets from CWD
      const { addresses, newCount } = detectWallets(process.cwd());
      if (newCount > 0) {
        ui.ok(`Detected ${addresses.length} wallets (${newCount} new)`);
      } else if (addresses.length > 0) {
        console.log(`  ${ui.dim(`${addresses.length} wallets loaded`)}`);
      }

      const { startDashboardServer } = await import("./dashboard");

      console.log("");
      console.log(`  ${ui.bold("APoW Dashboard")} starting on http://localhost:3847`);
      console.log(`  ${ui.dim("Press Ctrl+C to stop")}`);
      console.log("");

      const server = startDashboardServer({
        port: 3847,
        walletsPath,
        rpcUrl: config.rpcUrl,
        miningAgentAddress: config.miningAgentAddress as `0x${string}`,
        agentCoinAddress: config.agentCoinAddress as `0x${string}`,
      });

      // Open browser after short delay (server starts instantly)
      setTimeout(() => {
        const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        spawn(openCmd, ["http://localhost:3847"], { stdio: "ignore" });
      }, 500);

      // Wait for SIGINT
      await new Promise<void>((resolve) => {
        process.on("SIGINT", () => {
          server.close();
          resolve();
        });
      });
    });

  dashboardCmd
    .command("add <address>")
    .description("Add a wallet address to monitor")
    .action((address: string) => {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
        ui.error("Invalid address. Must be 0x + 40 hex characters.");
        return;
      }
      const walletsPath = getWalletsPath();
      const wallets = loadWallets(walletsPath);
      const lower = address.toLowerCase();
      if (wallets.some((w) => w.toLowerCase() === lower)) {
        ui.warn("Address already monitored.");
        return;
      }
      wallets.push(address);
      saveWallets(walletsPath, wallets);
      ui.ok(`Added ${address.slice(0, 6)}...${address.slice(-4)} (${wallets.length} wallets total)`);
    });

  dashboardCmd
    .command("remove <address>")
    .description("Remove a wallet address from monitoring")
    .action((address: string) => {
      const walletsPath = getWalletsPath();
      const wallets = loadWallets(walletsPath);
      const lower = address.toLowerCase();
      const filtered = wallets.filter((w) => w.toLowerCase() !== lower);
      if (filtered.length === wallets.length) {
        ui.warn("Address not found in wallet list.");
        return;
      }
      saveWallets(walletsPath, filtered);
      ui.ok(`Removed ${address.slice(0, 6)}...${address.slice(-4)} (${filtered.length} wallets remaining)`);
    });

  dashboardCmd
    .command("scan [dir]")
    .description("Auto-detect wallets from wallet-0x*.txt files in a directory")
    .action((dir?: string) => {
      const scanDir = dir ?? process.cwd();
      const { addresses, newCount } = detectWallets(scanDir);
      console.log("");
      if (addresses.length === 0) {
        console.log(`  No wallets found in ${scanDir}`);
        console.log(`  ${ui.dim("Expected files named wallet-0x<address>.txt")}`);
      } else {
        console.log(`  ${ui.bold("Detected Wallets")} (${newCount} new, ${addresses.length} total)`);
        console.log("");
        for (const addr of addresses) {
          console.log(`  ${addr}`);
        }
      }
      console.log("");
    });

  dashboardCmd
    .command("wallets")
    .description("List monitored wallet addresses")
    .action(() => {
      const walletsPath = getWalletsPath();
      const wallets = loadWallets(walletsPath);
      if (wallets.length === 0) {
        console.log("  No wallets configured. Run: apow dashboard add <address>");
        return;
      }
      console.log("");
      console.log(`  ${ui.bold("Monitored Wallets")} (${wallets.length})`);
      console.log("");
      for (const w of wallets) {
        console.log(`  ${w}`);
      }
      console.log("");
    });

  await program.parseAsync(process.argv);
}

function getWalletsPath(): string {
  return join(process.env.HOME ?? "", ".apow", "wallets.json");
}

function loadWallets(path: string): string[] {
  try {
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data.filter((a: unknown) => typeof a === "string") : [];
  } catch {
    return [];
  }
}

function saveWallets(path: string, wallets: string[]): void {
  const dir = join(process.env.HOME ?? "", ".apow");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(wallets, null, 2), "utf8");
}

function detectWallets(scanDir: string): { addresses: string[]; newCount: number } {
  const walletsPath = getWalletsPath();
  const existing = loadWallets(walletsPath);
  const seen = new Set(existing.map((a) => a.toLowerCase()));
  const detected: string[] = [];

  // Scan scanDir for wallet-0x*.txt files
  try {
    const entries = readdirSync(scanDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const match = entry.name.match(/^wallet-(0x[0-9a-fA-F]{40})\.txt$/);
        if (match && !seen.has(match[1].toLowerCase())) {
          detected.push(match[1]);
          seen.add(match[1].toLowerCase());
        }
      }
      // Scan rig*/wallet-0x*.txt subdirectories
      if (entry.isDirectory() && entry.name.startsWith("rig")) {
        try {
          const rigFiles = readdirSync(join(scanDir, entry.name));
          for (const file of rigFiles) {
            const m = file.match(/^wallet-(0x[0-9a-fA-F]{40})\.txt$/);
            if (m && !seen.has(m[1].toLowerCase())) {
              detected.push(m[1]);
              seen.add(m[1].toLowerCase());
            }
          }
        } catch {
          // rig dir not readable — skip
        }
      }
    }
  } catch {
    // scanDir not readable
  }

  const merged = [...existing, ...detected];
  if (detected.length > 0) {
    saveWallets(walletsPath, merged);
  }
  return { addresses: merged, newCount: detected.length };
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  ui.error(message);
  process.exitCode = 1;
});
