#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Command } from "commander";

import type { Abi, Address } from "viem";
import { createPublicClient, formatEther, formatUnits, getAddress, http, parseEther } from "viem";

import miningAgentAbiJson from "./abi/MiningAgent.json";
import { config, reloadConfig, resolveDefaultModel, usdcRequired, writeEnvFile, type LlmProvider } from "./config";
import { MIN_ETH, MIN_USDC } from "./bridge/constants";
import { getUsdcBalance } from "./bridge/uniswap";
import { detectMiners, detectMinersWithClient, formatHashpower, selectBestMiner } from "./detect";
import { errorText } from "./errors";
import { txUrl } from "./explorer";
import { detectGrinders, grinderLabel, hasNativeGrinders } from "./grinder-native";
import {
  generateKeystorePassword,
  isKeychainUsable,
  keychainPasswordCommand,
  storeKeystorePasswordInKeychain,
} from "./keychain";
import { runFundFlow } from "./fund";
import { runMintFlow } from "./mint";
import { startMining } from "./miner";
import { runPreflight } from "./preflight";
import { childEnv } from "./secure-env";
import { setSessionPassword } from "./signer/session";
import { displayStats } from "./stats";
import { runSweep } from "./sweep";
import { warnIfUpdateAvailable } from "./update";
import * as ui from "./ui";
import { detectWalletAddressFromFilename, loadEncryptedKeystoreFile, resolveKeystorePath, saveEncryptedKeystoreFile, savePlaintextImportFile } from "./wallet-store";
import { account, getEthBalance, publicClient, reinitClients, requireWallet } from "./wallet";
import { setSignerContext } from "./policy/context";
import { getPayoutAddress, loadPolicy, savePolicy, writeDefaultPolicyFile } from "./policy/policy";

const miningAgentAbi = miningAgentAbiJson as Abi;
const erc20BalanceAbi = [
  {
    type: "function" as const,
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view" as const,
  },
] as const;
const TRANSFER_GAS_RESERVE_ETH = parseEther("0.00005");

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

function ensureGitignoreSafetyEntries(): void {
  const gitignorePath = join(process.cwd(), ".gitignore");
  const wanted = [".env", "wallet-*.txt"];
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const missing = wanted.filter((entry) => !existing.split(/\r?\n/).includes(entry));
  if (missing.length === 0) {
    return;
  }

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const content = `${existing}${prefix}${missing.join("\n")}\n`;
  writeFileSync(gitignorePath, content, "utf8");
  ui.ok(`Updated .gitignore: added ${missing.join(", ")}`);
}

function getKeystorePasswordFromEnv(): string {
  const envPassword = process.env.KEYSTORE_PASSWORD?.trim();
  if (envPassword) return envPassword;
  return process.env.APOW_KEYSTORE_PASSWORD?.trim() ?? "";
}

async function getKeystorePassword(required: boolean, confirmPassword = true): Promise<string | null> {
  const envPassword = getKeystorePasswordFromEnv();
  if (envPassword) {
    return envPassword;
  }

  if (!ui.isInteractiveSession()) {
    if (required) {
      ui.error("KEYSTORE_PASSWORD is required to create or unlock an encrypted wallet in a headless session.");
      ui.hint("Set KEYSTORE_PASSWORD in your shell or secret manager, not in chat or command history.");
    }
    return null;
  }

  const entered = await ui.promptSecret("Keystore password");
  if (!entered) {
    if (required) {
      ui.error("No keystore password entered.");
    }
    return null;
  }
  if (confirmPassword) {
    const confirm = await ui.promptSecret("Confirm keystore password");
    if (entered !== confirm) {
      ui.error("Keystore passwords did not match.");
      return null;
    }
  }
  setSessionPassword(entered);
  return entered;
}

async function saveKeystoreWithPassword(
  address: `0x${string}`,
  privateKey: `0x${string}`,
  password: string,
): Promise<string> {
  setSessionPassword(password);
  return saveEncryptedKeystoreFile(address, privateKey, password);
}

// Acquire the password that encrypts a NEW keystore. On macOS we generate a
// strong random password, store it in the Keychain, and return the command that
// retrieves it (to wire as KEYSTORE_PASSWORD_CMD) — the user is never asked to
// type a secret. Elsewhere we fall back to the interactive typed-password flow.
async function provisionKeystorePassword(
  address: `0x${string}`,
  required: boolean,
): Promise<{ password: string; passwordCmd?: string } | null> {
  if (isKeychainUsable()) {
    try {
      const password = generateKeystorePassword();
      storeKeystorePasswordInKeychain(address, password);
      return { password, passwordCmd: keychainPasswordCommand(address) };
    } catch (error) {
      // Never let a Keychain hiccup abort setup or surface a scary dialog —
      // quietly fall back to the interactive password flow.
      ui.warn(`macOS Keychain unavailable (${errorText(error)}); using a typed password instead.`);
    }
  }
  const password = await getKeystorePassword(required);
  if (!password) return null;
  return { password };
}

// Prefer a free local LLM CLI for the mint puzzle if one is installed, so the
// streamlined wizard doesn't have to ask. Returns null if none is on PATH.
function detectLocalLlm(): LlmProvider | null {
  const has = (cmd: string) => spawnSync(`command -v ${cmd}`, { shell: true, stdio: "ignore" }).status === 0;
  if (has("codex")) return "codex";
  if (has("claude")) return "claude-code";
  if (has("ollama")) return "ollama";
  return null;
}

async function saveWalletArtifacts(
  address: `0x${string}`,
  privateKey: `0x${string}`,
  opts: { createPlaintextImportFile?: boolean; requireKeystore?: boolean } = {},
): Promise<{ plaintextPath?: string; keystorePath?: string; passwordCmd?: string }> {
  const result: { plaintextPath?: string; keystorePath?: string; passwordCmd?: string } = {};

  if (opts.createPlaintextImportFile === true) {
    result.plaintextPath = savePlaintextImportFile(address, privateKey);
  }

  const provisioned = await provisionKeystorePassword(address, opts.requireKeystore === true);
  if (provisioned) {
    result.keystorePath = await saveKeystoreWithPassword(address, privateKey, provisioned.password);
    result.passwordCmd = provisioned.passwordCmd;
  } else if (opts.requireKeystore) {
    throw new Error("Encrypted keystore was not created.");
  }
  return result;
}

async function unlockConfiguredKeystoreIfNeeded(): Promise<boolean> {
  if (account && config.privateKey) {
    return true;
  }

  if (!config.keystorePath) {
    return false;
  }

  const password = await getKeystorePassword(true, false);
  if (!password) {
    return false;
  }

  try {
    loadEncryptedKeystoreFile(config.keystorePath, password);
    reloadConfig();
    reinitClients();
    return !!account && !!config.privateKey;
  } catch (error) {
    ui.error(`Could not unlock encrypted keystore: ${errorText(error)}`);
    return false;
  }
}

async function confirmPrivateKeyDisplay(): Promise<boolean> {
  if (!ui.isInteractiveSession()) {
    return false;
  }
  const answer = await ui.prompt("Type SHOW to display your private key");
  return answer === "SHOW";
}

function shouldSkipUpdateCheck(argv: string[]): boolean {
  return argv.includes("--help")
    || argv.includes("-h")
    || argv.includes("--version")
    || argv.includes("-V")
    || argv[0] === "help";
}

async function setupWizard(): Promise<void> {
  console.log("");
  ui.banner(["APoW Agent Setup"]);
  console.log("");

  // Mode selection
  console.log(`  ${ui.bold("Choose an operating mode")}`);
  console.log("");
  console.log(`  ${ui.cyan("1.")} Easy Mode ${ui.dim("(recommended)")}`);
  console.log(`     ${ui.dim("No config. Wallet + x402 RPC + x402 LLM + x402 GPU grind.")}`);
  console.log(`  ${ui.cyan("2.")} Advanced Mode`);
  console.log(`     ${ui.dim("Choose which parts your agent manages and which credentials you supply.")}`);
  console.log("");
  const modeInput = await ui.prompt("Choice", "1");
  const easyMode = modeInput !== "2";
  console.log("");

  const totalSteps = easyMode ? 2 : 4;
  const values: Record<string, string> = {};

  // Step 1: Wallet
  console.log(`  ${ui.bold(`Step 1/${totalSteps}: Wallet`)}`);
  console.log(`  ${ui.dim("Your agent can manage a wallet for you, or you can supply your own.")}`);
  console.log("");
  console.log(`  ${ui.cyan("1.")} Generate agent-managed encrypted wallet ${ui.dim("(recommended)")}`);
  console.log(`  ${ui.cyan("2.")} Existing private key ${ui.dim("(supply your own wallet)")}`);
  console.log("");
  const keychainManaged = isKeychainUsable();
  if (keychainManaged) {
    console.log(`  ${ui.dim("The keystore password is generated and stored in your macOS Keychain.")}`);
    console.log(`  ${ui.dim("apow never asks you to type it — macOS authorizes access when mining.")}`);
    console.log("");
  }
  const walletMode = await ui.prompt("Wallet choice", "1");

  let addr: string;
  let keystorePath: string | undefined;
  let passwordCmd: string | undefined;

  if (walletMode === "2") {
    const inputKey = await ui.promptSecret("Private key (0x-prefixed)");
    if (!inputKey) {
      ui.error("Private key is required.");
      return;
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(inputKey)) {
      ui.error("Invalid private key format. Must be 0x + 64 hex characters.");
      return;
    }
    const { privateKeyToAccount } = await import("viem/accounts");
    const walletAccount = privateKeyToAccount(inputKey as `0x${string}`);
    addr = walletAccount.address;
    const provisioned = await provisionKeystorePassword(addr as `0x${string}`, true);
    if (!provisioned) {
      return;
    }
    passwordCmd = provisioned.passwordCmd;
    keystorePath = await saveKeystoreWithPassword(addr as `0x${string}`, inputKey as `0x${string}`, provisioned.password);
    console.log("");
    console.log(`  ${ui.dim(`Encrypted keystore saved to: ${keystorePath}`)}`);
    if (keychainManaged) {
      console.log(`  ${ui.dim("Keystore password stored in macOS Keychain.")}`);
    }
  } else {
    const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
    const privateKey = generatePrivateKey();
    const walletAccount = privateKeyToAccount(privateKey);
    addr = walletAccount.address;
    const provisioned = await provisionKeystorePassword(addr as `0x${string}`, true);
    if (!provisioned) {
      return;
    }
    passwordCmd = provisioned.passwordCmd;
    keystorePath = await saveKeystoreWithPassword(addr as `0x${string}`, privateKey, provisioned.password);

    console.log("");
    console.log(`  ${ui.bold("NEW WALLET GENERATED")}`);
    console.log("");
    console.log(`  Address:     ${addr}`);
    console.log(`  Keystore:    ${keystorePath}`);
    if (keychainManaged) {
      console.log(`  Password:    stored in macOS Keychain (apow never sees you type it)`);
    }
    console.log("");
    console.log(`  ${ui.yellow("Back up now:")} ${ui.dim("apow wallet export --show-private-key")}`);
    console.log(`  ${ui.dim("If you lose the Keychain entry, the keystore can't be unlocked.")}`);
    console.log("");
    console.log(`  ${ui.dim("Fund this address with ≥0.005 ETH on Base to start.")}`);
    console.log("");
  }

  values.PRIVATE_KEY = "";
  if (keystorePath) {
    values.KEYSTORE_PATH = keystorePath;
  }
  if (passwordCmd) {
    values.KEYSTORE_PASSWORD_CMD = passwordCmd;
  }
  ui.ok(`Wallet: ${addr.slice(0, 6)}...${addr.slice(-4)}`);
  console.log("");

  if (easyMode) {
    // Easy Mode: fully autonomous x402 stack
    console.log(`  ${ui.bold(`Step 2/${totalSteps}: Configuration`)}`);
    values.USE_X402 = "true";
    values.USE_X402_GRIND = "true";
    values.LLM_PROVIDER = "clawrouter";
    values.LLM_MODEL = "blockrun/eco";
    values.ALLOW_LOCAL_FALLBACK_WITH_X402 = "false";
    ui.ok("RPC: QuickNode x402 (wallet-paid, no API key)");
    ui.ok("LLM: ClawRouter x402 (wallet-paid, no API key)");
    ui.ok("Grinder: x402 GPU (remote, wallet-paid, no local CPU fallback)");
    console.log(`  ${ui.dim("Easy mode is agent-first: no RPC key, no LLM key, no GPU rental setup.")}`);
    console.log(`  ${ui.dim("Fund the wallet with ETH + USDC on Base, then run: apow start")}`);
  } else {
    // Advanced: one question (your RPC). Everything else is auto-detected.
    console.log(`  ${ui.bold(`Step 2/${totalSteps}: RPC`)}`);
    console.log(`  ${ui.dim("Paste your Base RPC URL, or press Enter to let your wallet pay per call (x402).")}`);
    console.log("");
    const existingRpc = process.env.RPC_URL?.trim() ?? "";
    const rpcUrl = (await ui.prompt("RPC URL (Enter = wallet-paid x402)", existingRpc)).trim();
    if (rpcUrl) {
      values.RPC_URL = rpcUrl;
      ui.ok(`RPC: ${rpcUrl.replace(/(https?:\/\/[^/]+).*/, "$1/…")}`);
    } else {
      values.USE_X402 = "true";
      ui.ok("RPC: wallet-paid x402");
    }
    console.log("");

    // Step 3: Mint AI (LLM) — quick numbered pick; cloud default works for everyone.
    console.log(`  ${ui.bold(`Step 3/${totalSteps}: Mint AI`)} ${ui.dim("(solves the mint puzzle once — not used while mining)")}`);
    console.log("");
    console.log(`  ${ui.cyan("1.")} ClawRouter   ${ui.dim("no API key, your wallet pays per solve  (easiest)")}`);
    console.log(`  ${ui.cyan("2.")} OpenAI       ${ui.dim("API key")}`);
    console.log(`  ${ui.cyan("3.")} Anthropic    ${ui.dim("API key")}`);
    console.log(`  ${ui.cyan("4.")} Local        ${ui.dim("codex / claude-code / ollama")}`);
    console.log(`  ${ui.cyan("5.")} More…        ${ui.dim("gemini / deepseek / qwen")}`);
    console.log("");
    const llmPick = (await ui.prompt("Pick", "1")).trim();
    let provider: LlmProvider = "clawrouter";
    if (llmPick === "2") provider = "openai";
    else if (llmPick === "3") provider = "anthropic";
    else if (llmPick === "4") {
      const local = detectLocalLlm();
      if (local) {
        provider = local;
      } else {
        const which = (await ui.prompt("Which local — codex / claude-code / ollama", "codex")).trim();
        provider = (["codex", "claude-code", "ollama"].includes(which) ? which : "codex") as LlmProvider;
      }
    } else if (llmPick === "5") {
      const which = (await ui.prompt("Which — gemini / deepseek / qwen", "gemini")).trim();
      provider = (["gemini", "deepseek", "qwen"].includes(which) ? which : "gemini") as LlmProvider;
    }
    values.LLM_PROVIDER = provider;
    values.LLM_MODEL = resolveDefaultModel(provider);

    if (provider === "clawrouter") {
      ui.ok("ClawRouter — no API key, wallet pays per solve");
      if (!values.RPC_URL) values.USE_X402 = "true";
    } else if (provider === "ollama") {
      const url = (await ui.prompt("Ollama URL", "http://127.0.0.1:11434")).trim();
      values.OLLAMA_URL = url;
      ui.ok(`Ollama at ${url}`);
    } else if (provider === "codex" || provider === "claude-code") {
      ui.ok(`Local ${provider} — make sure it's installed and authenticated`);
    } else {
      const key = await ui.promptSecret(`${provider} API key`);
      if (key) {
        values.LLM_API_KEY = key;
        ui.ok(`${provider} key saved`);
      } else {
        ui.hint("No key entered — set LLM_API_KEY in .env before minting.");
      }
    }
    console.log("");

    // Step 4: GPU grinder — quick numbered pick; cloud default needs no install.
    console.log(`  ${ui.bold(`Step 4/${totalSteps}: GPU grinder`)} ${ui.dim("(finds the mining nonce)")}`);
    console.log("");
    console.log(`  ${ui.cyan("1.")} Cloud GPU    ${ui.dim("your wallet pays, nothing to install  (easiest)")}`);
    console.log(`  ${ui.cyan("2.")} Local        ${ui.dim("Metal / CUDA / CPU on this machine")}`);
    console.log("");
    const grindPick = (await ui.prompt("Pick", "1")).trim();
    values.ALLOW_LOCAL_FALLBACK_WITH_X402 = "false";
    if (grindPick === "2") {
      values.USE_X402_GRIND = "false";
      const grinders = detectGrinders();
      if (hasNativeGrinders(grinders)) {
        ui.ok(`Local grinder: ${grinderLabel(grinders)}`);
      } else {
        ui.warn("No local grinder binaries found yet.");
        ui.hint("Run `apow build-grinders` to compile Metal/CPU grinders for this machine.");
      }
    } else {
      values.USE_X402_GRIND = "true";
      ui.ok("Cloud GPU — wallet pays per grind");
    }
    console.log("");
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
  const policyFile = writeDefaultPolicyFile();
  reloadConfig();
  reinitClients();
  ui.ok("Config saved to .env");
  ui.ok(`Policy saved to ${policyFile}`);
  ensureGitignoreSafetyEntries();

  console.log("");
  console.log(`  Next: ${ui.cyan("apow start")}`);
  console.log(`        ${ui.dim("Guided happy path: setup -> fund -> mint -> mine")}`);
  console.log("");
}

function showHeadlessFundingHandoff(address: `0x${string}`, needsEth: boolean, needsUsdc: boolean): void {
  ui.warn("Headless session detected — pausing before funding.");
  ui.hint(`Send funds to ${address} on Base.`);
  if (needsEth) {
    ui.hint(`Need at least ${MIN_ETH} ETH for gas and minting.`);
  }
  if (needsUsdc) {
    ui.hint(`Need at least ${MIN_USDC} USDC for QuickNode + ClawRouter x402.`);
  }
  ui.hint("Funding routes:");
  ui.hint("Direct on Base: send ETH and/or USDC to this wallet");
  ui.hint("Bridge from Solana: apow fund --chain solana --token sol");
  ui.hint("Bridge from Ethereum: apow fund --chain ethereum");
  ui.hint("After funds arrive, rerun `apow start`.");
}

async function runStartFlow(): Promise<void> {
  await unlockConfiguredKeystoreIfNeeded();

  if (!config.privateKey || !account) {
    console.log("");
    ui.warn("No wallet configured — launching setup.");
    await setupWizard();
    reloadConfig();
    reinitClients();
  }

  if (!account) {
    ui.error("Wallet configuration did not complete.");
    return;
  }

  const bootstrapClient = config.useX402 && config.chainName === "base" && config.rpcUrl
    ? createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) })
    : publicClient;

  console.log("");
  ui.banner(["APoW Start"]);
  console.log("");

  let miners = [] as Awaited<ReturnType<typeof detectMinersWithClient>>;
  try {
    miners = await detectMinersWithClient(bootstrapClient, account.address);
  } catch {
    ui.warn("Could not query wallet rigs via bootstrap RPC — continuing with funding guidance.");
  }
  if (miners.length > 0) {
    const best = selectBestMiner(miners);
    console.log(`  ${ui.green("Wallet ready.")} Found ${miners.length} rig${miners.length === 1 ? "" : "s"} — starting miner #${best.tokenId}.`);
    console.log("");
    await runPreflight("mining");
    await startMining(best.tokenId);
    return;
  }

  let ethBalance = 0;
  let usdcBalance = 0;
  let balanceChecksAvailable = true;
  try {
    const [ethBalanceRaw, usdcBalanceRaw] = await Promise.all([
      bootstrapClient.getBalance({ address: account.address }),
      config.useX402
        ? bootstrapClient.readContract({
            address: config.chainName === "base" ? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" : config.agentCoinAddress,
            abi: erc20BalanceAbi,
            functionName: "balanceOf",
            args: [account.address],
          }) as Promise<bigint>
        : Promise.resolve(0n),
    ]);
    ethBalance = Number(formatEther(ethBalanceRaw));
    usdcBalance = Number(formatUnits(usdcBalanceRaw, 6));
  } catch {
    balanceChecksAvailable = false;
    ui.warn("Could not query wallet balances via bootstrap RPC — funding flow may still be needed.");
  }

  const needsEth = !balanceChecksAvailable || ethBalance < MIN_ETH;
  const needsUsdc = usdcRequired() && (!balanceChecksAvailable || usdcBalance < MIN_USDC);

  if (needsEth || needsUsdc) {
    console.log(`  ${ui.yellow("Funding needed before minting.")}`);
    ui.table([
      ["Wallet", `${account.address.slice(0, 6)}...${account.address.slice(-4)}`],
      ["ETH", balanceChecksAvailable ? `${ethBalance.toFixed(6)} ETH${needsEth ? ` (need ≥${MIN_ETH})` : ""}` : "unknown (RPC check failed)"],
      ["USDC", usdcRequired() ? (balanceChecksAvailable ? `${usdcBalance.toFixed(2)} USDC${needsUsdc ? ` (need ≥${MIN_USDC})` : ""}` : "unknown (RPC check failed)") : "not required"],
    ]);
    console.log("");

    if (!ui.isInteractiveSession()) {
      showHeadlessFundingHandoff(account.address, needsEth, needsUsdc);
      return;
    }

    const runFunding = await ui.confirm("Run funding flow now?");
    if (!runFunding) {
      ui.hint("Fund the wallet, then rerun `apow start`.");
      return;
    }

    setSignerContext("fund");
    await runFundFlow({});

    const refreshedEth = Number(formatEther(await getEthBalance()));
    const refreshedUsdc = config.useX402 ? Number(formatUnits(await getUsdcBalance(account.address), 6)) : usdcBalance;
    if (refreshedEth < MIN_ETH || (config.useX402 && refreshedUsdc < MIN_USDC)) {
      ui.warn("Funding is still incomplete.");
      ui.hint("Bridge or deposit may still be pending. Rerun `apow start` once balances update.");
      return;
    }
  }

  setSignerContext("mint");
  await runMintFlow({ startMiningAfterMint: true });
}

async function main(): Promise<void> {
  const version = readVersion();
  const argv = process.argv.slice(2);
  if (!shouldSkipUpdateCheck(argv)) {
    void warnIfUpdateAvailable(version);
  }
  const program = new Command();

  // SIGINT handler
  process.on("SIGINT", async () => {
    ui.stopAll();
    try {
      const { stopClawRouter, isClawRouterRunning } = await import("./clawrouter");
      if (isClawRouterRunning()) await stopClawRouter();
    } catch {}
    console.log("");
    console.log(ui.dim("  Interrupted. Bye!"));
    process.exit(0);
  });

  program
    .name("apow")
    .description("Mine AGENT tokens on Base L2 with Agentic Proof of Work")
    .version(version);

  if (config.walletSource === "private-key") {
    ui.warn("Legacy PRIVATE_KEY is loaded. Run `apow wallet migrate` to encrypt it into a keystore.");
  }

  program
    .command("setup")
    .description("Agent-first setup wizard — choose Easy Mode (x402 for everything) or Advanced Mode")
    .action(async () => {
      await setupWizard();
    });

  program
    .command("start")
    .description("Agent-first happy path: setup -> fund -> mint -> mine")
    .action(async () => {
      await runStartFlow();
    });

  program
    .command("fund")
    .description("Fund your wallet — bridge from Solana/Ethereum or send on Base")
    .option("--chain <chain>", "Source chain: solana, ethereum, base")
    .option("--token <token>", "Source token: sol, usdc, eth")
    .option("--amount <eth>", "Target ETH amount (default: 0.005)")
    .option("--no-swap", "Skip auto-split after bridging")
    .action(async (opts: { chain?: string; token?: string; amount?: string; swap?: boolean }) => {
      setSignerContext("fund");
      await unlockConfiguredKeystoreIfNeeded();
      if (!config.privateKey || !account) {
        ui.warn("No wallet configured — launching setup first.");
        await setupWizard();
        reloadConfig();
        reinitClients();
        if (!account) {
          ui.error("Wallet configuration did not complete.");
          return;
        }
      }
      await runFundFlow(opts);
    });

  program
    .command("mint")
    .description("Mint a new miner NFT (Easy Mode: x402 LLM, no API key)")
    .action(async () => {
      setSignerContext("mint");
      await unlockConfiguredKeystoreIfNeeded();
      if (!config.privateKey || !account) {
        ui.warn("No wallet configured — launching setup first.");
        await setupWizard();
        reloadConfig();
        reinitClients();
        if (!account) {
          ui.error("Wallet configuration did not complete.");
          return;
        }
      }
      await runPreflight("wallet");
      await runMintFlow();
    });

  program
    .command("mine")
    .description("Start the mining loop (Easy Mode: remote x402 GPU)")
    .argument("[tokenId]", "Miner token ID (auto-detects if omitted)")
    .action(async (tokenIdArg?: string) => {
      setSignerContext("mine");
      await unlockConfiguredKeystoreIfNeeded();
      const hasWallet = !!config.privateKey && !!account;
      const hasRpc = config.useX402 || !!config.rpcUrl;

      if (!hasWallet || !hasRpc) {
        ui.warn("Mining prerequisites are missing — launching guided start flow.");
        await runStartFlow();
        return;
      }

      const miningAccount = account!;
      let tokenId: bigint;
      if (tokenIdArg) {
        tokenId = parseTokenId(tokenIdArg);
        await runPreflight("mining");
      } else {
        await runPreflight("mining");
        let miners: Awaited<ReturnType<typeof detectMiners>>;
        try {
          miners = await detectMiners(miningAccount.address);
        } catch {
          ui.error("Could not detect mining rigs — RPC may be unreachable.");
          ui.hint("Check your RPC_URL or USDC balance for x402, then retry.");
          return;
        }
        if (miners.length === 0) {
          ui.warn("No mining rigs found — launching guided start flow.");
          await runStartFlow();
          return;
        }
        tokenId = selectBestMiner(miners).tokenId;
        if (miners.length === 1) {
          console.log(`  Using miner #${tokenId} (${miners[0].rarityLabel}, ${formatHashpower(miners[0].hashpower)})`);
        } else {
          const best = miners.find((m) => m.tokenId === tokenId)!;
          console.log(`  Found ${miners.length} miners — using #${best.tokenId} (${best.rarityLabel}, ${formatHashpower(best.hashpower)})`);
          for (const m of miners) {
            const marker = m.tokenId === tokenId ? ui.green(" *") : "  ";
            console.log(`  ${marker} #${m.tokenId} — ${m.rarityLabel} (${formatHashpower(m.hashpower)})`);
          }
        }
      }
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

  program
    .command("build-grinders")
    .description("Compile native grinder binaries for GPU/CPU mining (~10-100x faster)")
    .option("--cuda-arch <arch>", "CUDA architecture override (e.g., sm_89)")
    .action(async (opts: { cudaArch?: string }) => {
      const { buildGrinders } = await import("./build");
      await buildGrinders(opts);
    });

  const policyCmd = program
    .command("policy")
    .description("Show and configure local wallet signing policy");

  policyCmd
    .command("show")
    .description("Print the current wallet policy")
    .action(() => {
      setSignerContext("policy");
      console.log(JSON.stringify(loadPolicy(), null, 2));
    });

  policyCmd
    .command("init")
    .description("Write the default policy file")
    .option("--force", "Overwrite existing policy.json")
    .action((opts: { force?: boolean }) => {
      const path = writeDefaultPolicyFile(opts.force === true);
      ui.ok(`Policy file ready: ${path}`);
    });

  policyCmd
    .command("set")
    .description("Set policy values")
    .command("mode <mode>")
    .description("Set policy mode: enforce, warn, or off")
    .action((mode: string) => {
      if (mode !== "enforce" && mode !== "warn" && mode !== "off") {
        ui.error("Mode must be enforce, warn, or off.");
        return;
      }
      const policy = loadPolicy();
      policy.mode = mode;
      const path = savePolicy(policy);
      ui.ok(`Policy mode set to ${mode} in ${path}`);
      if (mode !== "enforce") {
        ui.warn("Policy is not enforcing. Use only as a temporary recovery mode.");
      }
    });

  const walletCmd = program
    .command("wallet")
    .description("Wallet generation and management");

  walletCmd
    .command("new")
    .description("Generate a new encrypted Base wallet")
    .option("--show-private-key", "Print the private key after generation (unsafe except for immediate import)")
    .action(async (opts: { showPrivateKey?: boolean }) => {
      // saveWalletArtifacts provisions the keystore password itself (macOS
      // Keychain when available, otherwise an interactive prompt).
      const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
      const key = generatePrivateKey();
      const acct = privateKeyToAccount(key);
      const artifacts = await saveWalletArtifacts(acct.address, key, {
        requireKeystore: true,
      });

      console.log("");
      console.log(`  ${ui.bold("NEW WALLET GENERATED")}`);
      console.log("");
      console.log(`  Address:     ${acct.address}`);
      if (artifacts.keystorePath) {
        console.log(`  Keystore:    ${artifacts.keystorePath}`);
      }
      if (artifacts.passwordCmd) {
        console.log(`  Password:    stored in macOS Keychain`);
      }
      console.log("");

      if (opts.showPrivateKey) {
        console.log(`  Private Key: ${key}`);
        console.log("");
        console.log(`  ${ui.yellow("WARNING: anyone with this key controls your funds.")}`);
      } else {
        console.log(`  ${ui.dim("Private key hidden. Export later with: apow wallet export --show-private-key")}`);
      }
      console.log("");
      console.log(`  ${ui.dim("Import into Phantom, MetaMask, or any EVM wallet")}`);
      console.log(`  ${ui.dim("to view your AGENT tokens and Mining Rig NFT.")}`);
      console.log("");
    });

  walletCmd
    .command("show")
    .description("Show configured wallet address")
    .action(async () => {
      await unlockConfiguredKeystoreIfNeeded();
      if (!account) {
        ui.error("No wallet configured. Run `apow setup` and choose Easy Mode, or set KEYSTORE_PATH or PRIVATE_KEY in .env.");
        return;
      }
      console.log("");
      console.log(`  Address: ${account.address}`);
      if (config.walletSource === "keystore" && config.keystorePath) {
        console.log(`  Source:  encrypted keystore (${config.keystorePath})`);
      } else if (config.walletSource === "private-key") {
        console.log("  Source:  legacy PRIVATE_KEY");
      }
      console.log("");
    });

  walletCmd
    .command("export")
    .description("Export wallet private key or create backup artifacts")
    .option("--show-private-key", "Display the decrypted private key")
    .option("--plaintext", "Save a plaintext wallet-<address>.txt import helper")
    .option("--i-understand-plaintext-risk", "Required with --plaintext")
    .option("--keystore", "Write or refresh the encrypted keystore backup")
    .action(async (opts: { showPrivateKey?: boolean; plaintext?: boolean; iUnderstandPlaintextRisk?: boolean; keystore?: boolean }) => {
      await unlockConfiguredKeystoreIfNeeded();
      if (!account || !config.privateKey) {
        ui.error("No wallet configured. Run `apow setup` and choose Easy Mode, or set KEYSTORE_PATH or PRIVATE_KEY in .env.");
        return;
      }

      if (opts.plaintext && !opts.iUnderstandPlaintextRisk) {
        ui.error("Refusing plaintext export without --i-understand-plaintext-risk.");
        return;
      }
      if (opts.plaintext && ui.isInteractiveSession()) {
        const typed = await ui.prompt("Type PLAINTEXT to create an unencrypted wallet file");
        if (typed !== "PLAINTEXT") {
          console.log("  Cancelled.");
          return;
        }
      }

      const shouldPrintKey = opts.showPrivateKey === true
        || (await confirmPrivateKeyDisplay());
      if (!shouldPrintKey && !opts.plaintext && !opts.keystore) {
        console.log("");
        console.log(`  Address: ${account.address}`);
        if (config.keystorePath) {
          console.log(`  Keystore: ${config.keystorePath}`);
        }
        console.log(`  ${ui.dim("Use --show-private-key only when you need to import the wallet elsewhere.")}`);
        console.log("");
        return;
      }

      console.log("");
      console.log(`  Address:     ${account.address}`);
      if (shouldPrintKey) {
        console.log(`  Private Key: ${config.privateKey}`);
        console.log(`  ${ui.yellow("WARNING: anyone with this key controls your funds.")}`);
      }
      console.log("");

      const artifacts = await saveWalletArtifacts(account.address, config.privateKey, {
        createPlaintextImportFile: opts.plaintext === true,
        requireKeystore: opts.keystore === true,
      });
      if (artifacts.plaintextPath) {
        console.log(`  ${ui.dim(`Saved import helper: ${artifacts.plaintextPath}`)}`);
      }
      if (artifacts.keystorePath) {
        console.log(`  ${ui.dim(`Saved encrypted keystore: ${artifacts.keystorePath}`)}`);
      }
      console.log("");
    });

  walletCmd
    .command("migrate")
    .description("Encrypt legacy PRIVATE_KEY into a keystore and clear .env PRIVATE_KEY")
    .action(async () => {
      if (config.walletSource !== "private-key" || !config.privateKey || !account) {
        ui.error("No legacy PRIVATE_KEY wallet is loaded.");
        return;
      }
      const provisioned = await provisionKeystorePassword(account.address, true);
      if (!provisioned) return;
      const keystorePath = await saveKeystoreWithPassword(account.address, config.privateKey, provisioned.password);
      const envUpdate: Record<string, string> = { PRIVATE_KEY: "", KEYSTORE_PATH: keystorePath };
      if (provisioned.passwordCmd) envUpdate.KEYSTORE_PASSWORD_CMD = provisioned.passwordCmd;
      await writeEnvFile(envUpdate);
      reloadConfig();
      reinitClients();
      ui.ok(`Encrypted keystore saved to ${keystorePath}`);
      if (provisioned.passwordCmd) {
        ui.hint("Keystore password stored in macOS Keychain; macOS will authorize unlocks.");
      }
      ui.hint("Unset PRIVATE_KEY in your shell or process manager if it is exported outside .env.");
    });

  const payoutCmd = walletCmd
    .command("payout")
    .description("Configure the cold payout address for mined AGENT sweeps");

  payoutCmd
    .command("set <address>")
    .description("Set payout address")
    .action(async (address: string) => {
      await unlockConfiguredKeystoreIfNeeded();
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
        ui.error("Invalid payout address.");
        return;
      }
      const payout = getAddress(address) as Address;
      if (account && payout.toLowerCase() === account.address.toLowerCase()) {
        ui.error("Payout address must differ from the mining wallet.");
        return;
      }
      const policy = loadPolicy();
      policy.payout = payout;
      const path = savePolicy(policy);
      ui.ok(`Payout set to ${payout.slice(0, 6)}...${payout.slice(-4)} in ${path}`);
    });

  payoutCmd
    .command("show")
    .description("Show configured payout address")
    .action(() => {
      const payout = getPayoutAddress();
      console.log("");
      console.log(`  Payout: ${payout ?? "(not configured)"}`);
      console.log("");
    });

  walletCmd
    .command("sweep")
    .description("Sweep mined AGENT to the configured payout address")
    .option("--all", "Also sweep excess ETH and USDC working balances")
    .action(async (opts: { all?: boolean }) => {
      setSignerContext("sweep");
      await unlockConfiguredKeystoreIfNeeded();
      await runSweep({ all: opts.all === true });
    });

  walletCmd
    .command("fund")
    .description("Send ETH from your wallet to another address")
    .argument("<address>", "Destination address (0x-prefixed)")
    .argument("[amount]", "ETH amount to send (default: mint price + 0.003 ETH gas buffer)")
    .action(async (address: string, amountArg?: string) => {
      setSignerContext("wallet-fund");
      await unlockConfiguredKeystoreIfNeeded();
      if (!config.privateKey || !account) {
        ui.warn("No wallet configured — launching setup first.");
        await setupWizard();
        reloadConfig();
        reinitClients();
        if (!account) {
          ui.error("Wallet configuration did not complete.");
          return;
        }
      }

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

      const requiredBalance = amount + TRANSFER_GAS_RESERVE_ETH;
      if (senderBalance < requiredBalance) {
        ui.error("Insufficient ETH balance.");
        ui.hint(`Need ${formatEther(amount)} ETH for the transfer plus ~${formatEther(TRANSFER_GAS_RESERVE_ETH)} ETH for send gas.`);
        ui.hint(`Have ${Number(formatEther(senderBalance)).toFixed(6)} ETH in the sender wallet.`);
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
      setSignerContext("dashboard");
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
        useX402: config.useX402,
        signer: account ?? undefined,
        legacyPrivateKey: config.privateKey as `0x${string}` | undefined,
        miningAgentAddress: config.miningAgentAddress as `0x${string}`,
        agentCoinAddress: config.agentCoinAddress as `0x${string}`,
      });

      // Open browser after short delay (server starts instantly)
      setTimeout(() => {
        const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        spawn(openCmd, ["http://localhost:3847"], { stdio: "ignore", env: childEnv() });
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
    .description("Auto-detect wallets from wallet-0x*.txt or wallet-0x*.json files in a directory")
    .action((dir?: string) => {
      const scanDir = dir ?? process.cwd();
      const { addresses, newCount } = detectWallets(scanDir);
      console.log("");
      if (addresses.length === 0) {
        console.log(`  No wallets found in ${scanDir}`);
        console.log(`  ${ui.dim("Expected files named wallet-0x<address>.txt or wallet-0x<address>.json")}`);
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

  // Scan scanDir for wallet-0x*.txt / .json files
  try {
    const entries = readdirSync(scanDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const address = detectWalletAddressFromFilename(entry.name);
        if (address && !seen.has(address.toLowerCase())) {
          detected.push(address);
          seen.add(address.toLowerCase());
        }
      }
      // Scan rig*/wallet-0x* subdirectories
      if (entry.isDirectory() && entry.name.startsWith("rig")) {
        try {
          const rigFiles = readdirSync(join(scanDir, entry.name));
          for (const file of rigFiles) {
            const address = detectWalletAddressFromFilename(file);
            if (address && !seen.has(address.toLowerCase())) {
              detected.push(address);
              seen.add(address.toLowerCase());
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
  ui.error(errorText(error));
  process.exitCode = 1;
});
