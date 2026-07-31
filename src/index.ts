#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Command } from "commander";

import type { Abi, Address } from "viem";
import { createPublicClient, formatEther, formatUnits, getAddress, http, parseEther } from "viem";

import miningAgentAbiJson from "./abi/MiningAgent.json";
import {
  config,
  isExpensiveModel,
  reloadConfig,
  resolveDefaultModel,
  resolveKeystorePassword,
  writeEnvFile,
  type LlmProvider,
} from "./config";
import { MIN_ETH, MIN_USDC } from "./bridge/constants";
import { detectMiners, detectMinersWithClient, formatHashpower, selectBestMiner } from "./detect";
import { errorText } from "./errors";
import { txUrl } from "./explorer";
import { runFundFlow } from "./fund";
import { resolveApiProvider, resolveLlmSetupMode, resolveLocalProvider } from "./llm-setup";
import { runMintFlow } from "./mint";
import { startMining } from "./miner";
import { runPreflight } from "./preflight";
import { childEnv } from "./secure-env";
import { setSessionPassword } from "./signer/session";
import { displayStats } from "./stats";
import { runSweep } from "./sweep";
import { warnIfUpdateAvailable } from "./update";
import * as ui from "./ui";
import { showBrandIntro } from "./brand-intro";
import {
  loadEncryptedKeystoreFile,
  loadGeneratedWalletAddresses,
  loadGeneratedWallets,
  registerGeneratedWallet,
  resolveKeystorePath,
  saveEncryptedKeystoreFile,
  type GeneratedWalletRecord,
} from "./wallet-store";
import { account, getEthBalance, publicClient, reinitClients, requireWallet } from "./wallet";
import { setSignerContext } from "./policy/context";
import {
  getPayoutAddress,
  loadPolicy,
  savePolicy,
  validateEasyModePolicyCaps,
  writeDefaultPolicyFile,
} from "./policy/policy";

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

async function getKeystorePassword(required: boolean, confirmPassword = true): Promise<string | null> {
  const configuredPassword = resolveKeystorePassword();
  if (configuredPassword) {
    return configuredPassword;
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

async function saveWalletArtifacts(
  address: `0x${string}`,
  privateKey: `0x${string}`,
  opts: { requireKeystore?: boolean } = {},
): Promise<{ keystorePath?: string }> {
  const result: { keystorePath?: string } = {};
  const password = await getKeystorePassword(opts.requireKeystore === true);
  if (password) {
    result.keystorePath = await saveKeystoreWithPassword(address, privateKey, password);
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

function isActiveGeneratedWallet(wallet: GeneratedWalletRecord): boolean {
  return !!config.keystorePath
    && resolveKeystorePath(config.keystorePath) === resolveKeystorePath(wallet.keystorePath);
}

function printGeneratedWallets(wallets: GeneratedWalletRecord[]): void {
  console.log("");
  console.log(`  ${ui.bold("APoW WALLETS")}`);
  console.log("");
  for (const [index, wallet] of wallets.entries()) {
    const active = isActiveGeneratedWallet(wallet) ? ` ${ui.green("(active)")}` : "";
    console.log(`  ${index + 1}. ${wallet.address}${active}`);
  }
  console.log("");
}

function resolveGeneratedWalletSelection(
  wallets: GeneratedWalletRecord[],
  selection: string,
): GeneratedWalletRecord | undefined {
  if (/^\d+$/.test(selection)) {
    const index = Number(selection) - 1;
    return wallets[index];
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(selection)) {
    return undefined;
  }
  return wallets.find((wallet) => wallet.address.toLowerCase() === selection.toLowerCase());
}

async function unlockGeneratedWallet(wallet: GeneratedWalletRecord): Promise<string | null> {
  const configuredPassword = resolveKeystorePassword();
  if (configuredPassword) {
    try {
      const privateKey = loadEncryptedKeystoreFile(wallet.keystorePath, configuredPassword);
      const { privateKeyToAccount } = await import("viem/accounts");
      if (privateKeyToAccount(privateKey).address.toLowerCase() === wallet.address.toLowerCase()) {
        return configuredPassword;
      }
    } catch {
      // This wallet may use a different password; prompt below when interactive.
    }
  }

  if (!ui.isInteractiveSession()) {
    ui.error("Could not unlock the selected wallet in this headless session.");
    ui.hint("Provide its password through KEYSTORE_PASSWORD_CMD or a shell secret manager.");
    return null;
  }

  const password = await ui.promptSecret(
    `Keystore password for ${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`,
  );
  if (!password) {
    ui.error("No keystore password entered.");
    return null;
  }

  try {
    const privateKey = loadEncryptedKeystoreFile(wallet.keystorePath, password);
    const { privateKeyToAccount } = await import("viem/accounts");
    if (privateKeyToAccount(privateKey).address.toLowerCase() !== wallet.address.toLowerCase()) {
      ui.error("The selected keystore does not match its registered wallet address.");
      return null;
    }
    return password;
  } catch {
    ui.error("Could not unlock the selected wallet. Check the password and try again.");
    return null;
  }
}

function shouldSkipUpdateCheck(argv: string[]): boolean {
  return argv.includes("--help")
    || argv.includes("-h")
    || argv.includes("--version")
    || argv.includes("-V")
    || argv[0] === "help";
}

interface SetupWizardOptions {
  easyMode?: boolean;
  showBrandIntro?: boolean;
}

async function setupWizard(options: SetupWizardOptions = {}): Promise<void> {
  if (options.showBrandIntro !== false) {
    await showBrandIntro("setup");
  }

  // Mode selection
  let easyMode = true;
  if (options.easyMode) {
    ui.ok("Easy Mode selected.");
  } else {
    console.log(`  ${ui.bold("Choose an operating mode")}`);
    console.log("");
    console.log(`  ${ui.cyan("1.")} Easy Mode ${ui.dim("(recommended)")}`);
    console.log(`     ${ui.dim("No config. Wallet + QuickNode x402 RPC + ClawRouter x402 LLM + RunPod x402 GPU.")}`);
    console.log(`  ${ui.cyan("2.")} Advanced Mode`);
    console.log(`     ${ui.dim("Choose which parts your agent manages and which credentials you supply.")}`);
    console.log("");
    const modeInput = await ui.prompt("Choice", "1");
    easyMode = modeInput !== "2";
  }
  console.log("");

  const totalSteps = easyMode ? 2 : 4;
  const values: Record<string, string> = {};

  // Step 1: Wallet
  console.log(`  ${ui.bold(`Step 1/${totalSteps}: Wallet`)}`);
  let walletMode = "1";
  if (options.easyMode) {
    console.log(`  ${ui.dim("Generating one dedicated encrypted APoW wallet.")}`);
    console.log("");
  } else {
    console.log(`  ${ui.dim("Your agent can manage a wallet for you, or you can supply your own.")}`);
    console.log("");
    console.log(`  ${ui.cyan("1.")} Agent-managed encrypted wallet ${ui.dim("(generate one now)")}`);
    console.log(`  ${ui.cyan("2.")} Existing encrypted keystore`);
    console.log(`  ${ui.cyan("3.")} Existing private key ${ui.dim("(encrypt before saving)")}`);
    console.log("");
    walletMode = await ui.prompt("Wallet choice", "1");
  }

  let addr: string;
  let keystorePath: string | undefined;

  if (walletMode === "2") {
    const inputPath = await ui.prompt("Keystore path", process.env.KEYSTORE_PATH ?? "");
    if (!inputPath) {
      ui.error("Keystore path is required.");
      return;
    }
    const password = await getKeystorePassword(true, false);
    if (!password) {
      return;
    }
    try {
      const privateKey = loadEncryptedKeystoreFile(inputPath, password);
      const { privateKeyToAccount } = await import("viem/accounts");
      const walletAccount = privateKeyToAccount(privateKey);
      addr = walletAccount.address;
      keystorePath = resolveKeystorePath(inputPath);
    } catch (error) {
      ui.error(`Could not unlock keystore: ${errorText(error)}`);
      return;
    }
  } else if (walletMode === "3") {
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
    const password = await getKeystorePassword(true);
    if (!password) {
      return;
    }
    keystorePath = await saveKeystoreWithPassword(addr as `0x${string}`, inputKey as `0x${string}`, password);
    console.log("");
    console.log(`  ${ui.dim(`Encrypted keystore saved to: ${keystorePath}`)}`);
  } else {
    const password = await getKeystorePassword(true);
    if (!password) {
      return;
    }
    const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
    const privateKey = generatePrivateKey();
    const walletAccount = privateKeyToAccount(privateKey);
    addr = walletAccount.address;
    keystorePath = await saveKeystoreWithPassword(addr as `0x${string}`, privateKey, password);
    registerGeneratedWallet(addr as `0x${string}`, keystorePath);

    console.log("");
    console.log(`  ${ui.bold("NEW WALLET GENERATED")}`);
    console.log("");
    console.log(`  Address:     ${addr}`);
    console.log(`  Keystore:    ${keystorePath}`);
    console.log("");
    console.log(`  ${ui.dim("Back up the encrypted keystore and its password separately.")}`);
    console.log("");
    console.log(`  ${ui.dim("Fund this address with ≥0.005 ETH on Base to start.")}`);
    console.log("");
  }

  values.PRIVATE_KEY = "";
  if (keystorePath) {
    values.KEYSTORE_PATH = keystorePath;
  }
  ui.ok(`Wallet: ${addr.slice(0, 6)}...${addr.slice(-4)}`);
  console.log("");

  if (easyMode) {
    // Easy Mode: automated wallet-paid x402 stack
    console.log(`  ${ui.bold(`Step 2/${totalSteps}: Configuration`)}`);
    values.USE_X402 = "true";
    values.USE_X402_GRIND = "true";
    values.LLM_PROVIDER = "clawrouter";
    values.ALLOW_LOCAL_FALLBACK_WITH_X402 = "false";
    ui.ok("RPC: Auto (Zero Config via QuickNode x402; wallet-paid in USDC)");
    ui.ok("LLM: Auto (Zero Config via ClawRouter x402; wallet-paid in USDC)");
    ui.ok("Grinder: Auto (Zero Config via RunPod x402; wallet-paid in USDC)");
    console.log(`  ${ui.dim("Easy mode is agent-first: no RPC key, no LLM key, no GPU rental setup.")}`);
    console.log(`  ${ui.dim(`Fund the wallet with ETH + USDC on Base, then run: apow start${options.easyMode ? " --easy" : ""}`)}`);
  } else {
    // Advanced: user picks which services remain autonomous
    // Step 2: RPC
    console.log(`  ${ui.bold(`Step 2/${totalSteps}: RPC`)}`);
    console.log(`  ${ui.dim("Choose automatic wallet-paid RPC or provide your own Base endpoint.")}`);
    console.log("");
    console.log(`  ${ui.cyan("1.")} Auto ${ui.dim("(recommended — Zero Config via QuickNode x402)")}`);
    console.log(`     ${ui.dim("No account or API key to connect.")}`);
    console.log(`  ${ui.cyan("2.")} Custom RPC URL`);
    console.log(`     ${ui.dim("Get a free Base RPC URL from Alchemy: https://www.alchemy.com/")}`);
    console.log("");
    const rpcMode = await ui.prompt("RPC choice", "1");

    if (rpcMode === "2") {
      const rpcUrl = await ui.prompt("RPC URL");
      if (rpcUrl) {
        values.RPC_URL = rpcUrl;
        ui.ok(`RPC: Custom (${rpcUrl.slice(0, 40)}${rpcUrl.length > 40 ? "..." : ""})`);
      } else {
        ui.warn("No URL provided — using Auto RPC via x402");
        values.USE_X402 = "true";
        ui.ok("RPC: Auto (Zero Config via QuickNode x402)");
      }
    } else {
      values.USE_X402 = "true";
      ui.ok("RPC: Auto (Zero Config via QuickNode x402; wallet-paid in USDC)");
    }
    console.log("");

    // Step 3: LLM (for minting)
    console.log(`  ${ui.bold(`Step 3/${totalSteps}: LLM (minting only)`)}`);
    console.log(`  ${ui.dim("An LLM solves the SMHL challenge when minting your Mining Rig.")}`);
    console.log(`  ${ui.dim("Mining uses optimized solving — no LLM needed after minting.")}`);
    console.log("");
    console.log(`  ${ui.cyan("1.")} Auto ${ui.dim("(recommended — Zero Config via ClawRouter x402)")}`);
    console.log(`     ${ui.dim("No account or API key to connect.")}`);
    console.log(`     ${ui.dim("Typical ClawRouter eco cost: $0–$0.0004 USDC per call; varies by usage.")}`);
    console.log(`  ${ui.cyan("2.")} API key ${ui.dim("(OpenAI, Anthropic, or Gemini; more providers available)")}`);
    console.log(`  ${ui.cyan("3.")} Local / subscription CLI ${ui.dim("(Ollama, Claude Code, or Codex)")}`);
    console.log("");

    const llmMode = resolveLlmSetupMode(await ui.prompt("LLM choice", "1"));
    let provider: LlmProvider;

    if (llmMode === "x402") {
      provider = "clawrouter";
      values.LLM_PROVIDER = provider;
      ui.ok("Auto LLM enabled — Zero Config via ClawRouter x402; wallet-paid in USDC");
      if (!values.USE_X402 && !values.RPC_URL) {
        values.USE_X402 = "true";
        ui.ok("Auto-enabled x402 RPC (same wallet, same USDC balance)");
      }
    } else if (llmMode === "api-key") {
      console.log("");
      console.log(`  ${ui.cyan("1.")} OpenAI`);
      console.log(`  ${ui.cyan("2.")} Anthropic`);
      console.log(`  ${ui.cyan("3.")} Gemini`);
      console.log(`  ${ui.cyan("4.")} DeepSeek`);
      console.log(`  ${ui.cyan("5.")} Qwen`);
      console.log("");
      provider = resolveApiProvider(await ui.prompt("API provider", "1"));
      values.LLM_PROVIDER = provider;

      const apiKey = await ui.promptSecret("API key");
      if (apiKey) {
        values.LLM_API_KEY = apiKey;
        ui.ok(`${provider} key set`);
      } else {
        ui.fail("No API key provided");
        ui.hint("Set LLM_API_KEY in .env later");
      }

      const model = await ui.prompt("Model", resolveDefaultModel(provider));
      values.LLM_MODEL = model;
      if (isExpensiveModel(model)) {
        ui.warn(`${model} is expensive. Consider a smaller model for lower cost.`);
      }
    } else {
      console.log("");
      console.log(`  ${ui.cyan("1.")} Ollama ${ui.dim("(model runs on this machine)")}`);
      console.log(`  ${ui.cyan("2.")} Claude Code ${ui.dim("(hosted via your Claude subscription)")}`);
      console.log(`  ${ui.cyan("3.")} Codex ${ui.dim("(hosted via your ChatGPT subscription)")}`);
      console.log("");
      provider = resolveLocalProvider(await ui.prompt("Local / subscription provider", "1"));
      values.LLM_PROVIDER = provider;

      const model = resolveDefaultModel(provider);
      values.LLM_MODEL = model;
      if (provider === "ollama") {
        const ollamaUrl = await ui.prompt("Ollama URL", "http://127.0.0.1:11434");
        values.OLLAMA_URL = ollamaUrl;
        values.LLM_MODEL = await ui.prompt("Ollama model", model);
        ui.ok(`Ollama at ${ollamaUrl} (local inference)`);
        ui.hint(`Run \`ollama pull ${values.LLM_MODEL}\` before minting.`);
      } else if (provider === "claude-code") {
        ui.ok(`Claude Code subscription — ${model} auto-selected`);
        ui.hint("Requires an installed, signed-in Claude Code CLI. APoW disables its tools for SMHL.");
      } else {
        ui.ok(`Codex subscription — ${model} auto-selected`);
        ui.hint("Requires an installed, signed-in Codex CLI. APoW uses a read-only isolated run for SMHL.");
      }
    }

    console.log("");

    // Step 4: Nonce grinding strategy
    console.log(`  ${ui.bold(`Step 4/${totalSteps}: GPU Grinding`)}`);
    console.log(`  ${ui.dim("Choose how the miner should find nonces at current network difficulty.")}`);
    console.log("");
    console.log(`  ${ui.cyan("1.")} Auto ${ui.dim("(recommended — Zero Config via RunPod x402)")}`);
    console.log(`     ${ui.dim("No account, API key, or GPU rental setup to connect.")}`);
    console.log(`  ${ui.cyan("2.")} Local CPU/GPU`);
    console.log("");
    const grindMode = await ui.prompt("Grinding choice", "1");

    if (grindMode === "2") {
      values.USE_X402_GRIND = "false";
      values.ALLOW_LOCAL_FALLBACK_WITH_X402 = "false";
      ui.ok("Grinding: Local CPU/GPU");
    } else {
      values.USE_X402_GRIND = "true";
      values.ALLOW_LOCAL_FALLBACK_WITH_X402 = "false";
      ui.ok("Grinding: Auto (Zero Config via RunPod x402)");
    }
  }

  // Contract addresses
  values.MINING_AGENT_ADDRESS = config.miningAgentAddress ?? "";
  values.AGENT_COIN_ADDRESS = config.agentCoinAddress ?? "";

  console.log("");

  // Check for existing .env
  const envPath = join(process.cwd(), ".env");
  if (existsSync(envPath) && !options.easyMode) {
    ui.hint("This updates APoW setup values, including the active wallet. Unrelated environment variables are kept.");
    const update = await ui.confirm("Update existing .env with these settings?");
    if (!update) {
      console.log("  Setup cancelled.");
      return;
    }
  }

  await writeEnvFile(values);
  const policyFile = writeDefaultPolicyFile();
  reloadConfig();
  reinitClients();
  ui.ok("Config saved to .env");
  ui.ok(`Policy ready at ${policyFile}`);
  ensureGitignoreSafetyEntries();

  if (!options.easyMode) {
    console.log("");
    console.log(`  Next: ${ui.cyan("apow start")}`);
    console.log(`        ${ui.dim("Guided happy path: setup -> fund -> mint -> mine")}`);
    console.log("");
  }
}

function showFundingHandoff(
  address: `0x${string}`,
  needsEth: boolean,
  needsUsdc: boolean,
  easyMode: boolean,
): void {
  ui.warn("Pausing for Base funding.");
  ui.hint(`Send funds to ${address} on Base.`);
  if (needsEth) {
    ui.hint(`Need at least ${MIN_ETH} ETH for gas and minting.`);
  }
  if (needsUsdc) {
    ui.hint(`Need at least ${MIN_USDC} USDC for x402 RPC + LLM services.`);
  }
  ui.hint(`After funds arrive, rerun \`apow start${easyMode ? " --easy" : ""}\`.`);
}

interface StartFlowOptions {
  easyMode?: boolean;
}

async function runStartFlow(options: StartFlowOptions = {}): Promise<void> {
  await showBrandIntro("start");

  const unlockedConfiguredWallet = await unlockConfiguredKeystoreIfNeeded();
  if (config.keystorePath && !unlockedConfiguredWallet && !account) {
    return;
  }

  if (!config.privateKey || !account) {
    console.log("");
    ui.warn("No wallet configured — launching setup.");
    await setupWizard({ easyMode: options.easyMode === true, showBrandIntro: false });
    reloadConfig();
    reinitClients();
  }

  if (!account) {
    ui.error("Wallet configuration did not complete.");
    return;
  }

  if (options.easyMode) {
    const policyError = validateEasyModePolicyCaps(loadPolicy());
    if (policyError) {
      ui.error(policyError);
      ui.hint("Restore the default enforce-mode Easy Mode caps, then retry.");
      return;
    }
  }

  const bootstrapClient = config.useX402 && config.chainName === "base" && config.rpcUrl
    ? createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) })
    : publicClient;

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
    await startMining(best.tokenId, { easyMode: options.easyMode === true });
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
  const needsUsdc = config.useX402 && (!balanceChecksAvailable || usdcBalance < MIN_USDC);

  if (needsEth || needsUsdc) {
    console.log(`  ${ui.yellow("Funding needed before minting.")}`);
    const fundingRows: [string, string][] = [
      ["Wallet", `${account.address.slice(0, 6)}...${account.address.slice(-4)}`],
      ["ETH", balanceChecksAvailable ? `${ethBalance.toFixed(6)} ETH${needsEth ? ` (need ≥${MIN_ETH})` : ""}` : "unknown (RPC check failed)"],
    ];
    if (config.useX402) {
      fundingRows.push([
        "USDC",
        balanceChecksAvailable ? `${usdcBalance.toFixed(2)} USDC${needsUsdc ? ` (need ≥${MIN_USDC})` : ""}` : "unknown (RPC check failed)",
      ]);
    }
    ui.table(fundingRows);
    console.log("");
    showFundingHandoff(account.address, needsEth, needsUsdc, options.easyMode === true);
    return;
  }

  setSignerContext("mint");
  await runMintFlow({
    easyMode: options.easyMode === true,
    startMiningAfterMint: true,
  });
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
    .description("Agent-first path: setup -> Base funding handoff -> mint -> mine")
    .option("--easy", "Use the existing Easy Mode without the mode-selection prompt")
    .action(async (opts: { easy?: boolean }) => {
      await runStartFlow({ easyMode: opts.easy === true });
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
    .action(async () => {
      const password = await getKeystorePassword(true);
      if (!password) {
        return;
      }

      const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
      const key = generatePrivateKey();
      const acct = privateKeyToAccount(key);
      const artifacts = await saveWalletArtifacts(acct.address, key, {
        requireKeystore: true,
      });
      registerGeneratedWallet(acct.address, artifacts.keystorePath!);

      console.log("");
      console.log(`  ${ui.bold("NEW WALLET GENERATED")}`);
      console.log("");
      console.log(`  Address:     ${acct.address}`);
      if (artifacts.keystorePath) {
        console.log(`  Keystore:    ${artifacts.keystorePath}`);
      }
      console.log("");
      console.log(`  ${ui.dim("Private key remains encrypted and is never printed.")}`);
      console.log(`  ${ui.dim("Back up the keystore and its password separately.")}`);
      console.log(`  ${ui.dim(`Activate it in this project with: apow wallet use ${acct.address}`)}`);
      console.log("");
    });

  walletCmd
    .command("list")
    .description("List wallets generated locally by this APoW CLI")
    .action(() => {
      const wallets = loadGeneratedWallets();
      if (wallets.length === 0) {
        ui.error("No locally generated APoW wallets found.");
        ui.hint("Create one with `apow wallet new` or the setup wizard.");
        return;
      }
      printGeneratedWallets(wallets);
    });

  walletCmd
    .command("use")
    .alias("select")
    .description("Select a locally generated APoW wallet for this project")
    .argument("[wallet]", "Wallet address or number from `apow wallet list`")
    .action(async (walletArg?: string) => {
      const wallets = loadGeneratedWallets();
      if (wallets.length === 0) {
        ui.error("No locally generated APoW wallets found.");
        ui.hint("Create one with `apow wallet new` or the setup wizard.");
        return;
      }

      let selection = walletArg?.trim() ?? "";
      if (!selection) {
        if (!ui.isInteractiveSession()) {
          ui.error("Specify a wallet address or number from `apow wallet list`.");
          return;
        }
        printGeneratedWallets(wallets);
        const activeIndex = wallets.findIndex(isActiveGeneratedWallet);
        selection = await ui.prompt(
          "Wallet number or address",
          String(activeIndex >= 0 ? activeIndex + 1 : 1),
        );
      }

      const selected = resolveGeneratedWalletSelection(wallets, selection);
      if (!selected) {
        ui.error("Wallet not found. Use an address or list number from `apow wallet list`.");
        return;
      }
      if (isActiveGeneratedWallet(selected)) {
        ui.ok(`Wallet already active: ${selected.address}`);
        return;
      }

      const password = await unlockGeneratedWallet(selected);
      if (!password) {
        return;
      }

      setSessionPassword(password);
      await writeEnvFile({ PRIVATE_KEY: "", KEYSTORE_PATH: selected.keystorePath });
      reinitClients();
      ui.ok(`Active wallet: ${selected.address}`);
      ui.hint(`Project config updated: ${join(process.cwd(), ".env")}`);
    });

  walletCmd
    .command("show")
    .description("Show configured wallet address")
    .action(async () => {
      await unlockConfiguredKeystoreIfNeeded();
      if (!account) {
        ui.error("No wallet configured. Run `apow setup` and choose Easy Mode, or configure KEYSTORE_PATH.");
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
    .command("backup")
    .description("Show the encrypted wallet backup location (never displays private keys)")
    .action(async () => {
      await unlockConfiguredKeystoreIfNeeded();
      if (!account) {
        ui.error("No wallet configured. Run `apow setup` and choose Easy Mode, or configure KEYSTORE_PATH.");
        return;
      }
      if (config.walletSource !== "keystore" || !config.keystorePath) {
        ui.error("This wallet is using the legacy environment-key path.");
        ui.hint("Run `apow wallet migrate` to create an encrypted keystore backup.");
        return;
      }

      console.log("");
      console.log(`  Address:  ${account.address}`);
      console.log(`  Keystore: ${config.keystorePath}`);
      console.log(`  ${ui.dim("Back up this encrypted file and its password separately.")}`);
      console.log(`  ${ui.dim("APoW never prints or writes a plaintext private-key export.")}`);
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
      const password = await getKeystorePassword(true);
      if (!password) return;
      const keystorePath = await saveKeystoreWithPassword(account.address, config.privateKey, password);
      await writeEnvFile({ PRIVATE_KEY: "", KEYSTORE_PATH: keystorePath });
      reloadConfig();
      reinitClients();
      ui.ok(`Encrypted keystore saved to ${keystorePath}`);
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
      if (config.useX402) {
        await unlockConfiguredKeystoreIfNeeded();
        const policy = loadPolicy();
        if (policy.mode !== "enforce") {
          ui.error("Paid dashboard reads require the wallet signing policy in enforce mode.");
          ui.hint("Run `apow policy set mode enforce`, then retry.");
          return;
        }
      }
      const generatedWallets = loadGeneratedWalletAddresses();
      const configuredAccount = account;
      const signerIsGenerated = !!configuredAccount && generatedWallets.some(
        (address) => address.toLowerCase() === configuredAccount.address.toLowerCase(),
      );
      if (config.useX402 && !signerIsGenerated) {
        ui.error("Dashboard x402 requires a configured wallet generated locally by this APoW CLI.");
        ui.hint("Run `apow wallet new`, configure its KEYSTORE_PATH, then retry.");
        return;
      }
      if (generatedWallets.length === 0) {
        ui.warn("No locally generated APoW wallets are registered. The dashboard will be empty.");
        ui.hint("Run `apow wallet new` to create and register one.");
      } else {
        console.log(`  ${ui.dim(`${generatedWallets.length} locally generated wallets loaded`)}`);
      }

      const { startDashboardServer } = await import("./dashboard");

      console.log("");
      console.log(`  ${ui.bold("APoW Dashboard")} starting on http://localhost:3847`);
      console.log(`  ${ui.dim("Press Ctrl+C to stop")}`);
      console.log("");

      const server = startDashboardServer({
        port: 3847,
        rpcUrl: config.rpcUrl,
        useX402: config.useX402,
        signer: signerIsGenerated ? configuredAccount ?? undefined : undefined,
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
    .command("wallets")
    .description("List locally generated APoW wallet addresses")
    .action(() => {
      const wallets = loadGeneratedWalletAddresses();
      if (wallets.length === 0) {
        console.log("  No locally generated APoW wallets. Run: apow wallet new");
        return;
      }
      console.log("");
      console.log(`  ${ui.bold("Locally Generated Wallets")} (${wallets.length})`);
      console.log("");
      for (const w of wallets) {
        console.log(`  ${w}`);
      }
      console.log("");
    });

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  ui.error(errorText(error));
  process.exitCode = 1;
});
