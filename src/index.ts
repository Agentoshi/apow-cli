#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";

import type { Abi } from "viem";
import { formatEther, parseEther } from "viem";

import miningAgentAbiJson from "./abi/MiningAgent.json";
import { config, isExpensiveModel, writeEnvFile, type LlmProvider } from "./config";
import { detectMiners, formatHashpower, selectBestMiner } from "./detect";
import { txUrl } from "./explorer";
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
  writeFileSync(filepath, content, "utf8");
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

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  ui.error(message);
  process.exitCode = 1;
});
