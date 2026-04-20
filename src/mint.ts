import type { Abi, Hex } from "viem";
import { formatEther, hexToBytes, parseEther } from "viem";

import miningAgentAbiJson from "./abi/MiningAgent.json";
import { config } from "./config";
import { txUrl, tokenUrl } from "./explorer";
import { normalizeSmhlChallenge, solveSmhlChallenge, type SmhlChallenge } from "./smhl";
import { formatHashpower, rarityLabels } from "./detect";
import { startMining } from "./miner";
import * as ui from "./ui";
import { getEthBalance, publicClient, requireWallet } from "./wallet";

const miningAgentAbi = miningAgentAbiJson as Abi;
const ZERO_SEED = `0x${"0".repeat(64)}` as Hex;
const MINT_GAS_RESERVE_ETH = parseEther("0.003");

export interface MintFlowOptions {
  startMiningAfterMint?: boolean;
}

function isExpiredMintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Expired");
}

function deriveChallengeFromSeed(seed: Hex): SmhlChallenge {
  const bytes = hexToBytes(seed);
  const firstNChars = 5 + (bytes[0] % 6);
  const wordCount = 3 + (bytes[2] % 5);
  const totalLength = 20 + (bytes[5] % 31);
  const charPosition = bytes[3] % totalLength;
  const charValue = 97 + (bytes[4] % 26);

  let targetAsciiSum = 400 + (bytes[1] * 3);
  let maxAsciiSum = firstNChars * 126;
  if (charPosition < firstNChars) {
    maxAsciiSum = maxAsciiSum - 126 + charValue;
  }

  if (targetAsciiSum > maxAsciiSum) {
    targetAsciiSum = 400 + ((targetAsciiSum - 400) % (maxAsciiSum - 399));
  }

  return normalizeSmhlChallenge([
    targetAsciiSum,
    firstNChars,
    wordCount,
    charPosition,
    charValue,
    totalLength,
  ]);
}

export async function runMintFlow(options: MintFlowOptions = {}): Promise<bigint | null> {
  const { account, walletClient } = requireWallet();
  console.log("");

  // 1-rig-per-wallet enforcement
  const existingBalance = (await publicClient.readContract({
    address: config.miningAgentAddress,
    abi: miningAgentAbi,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;

  if (existingBalance > 0n) {
    const tokenId = (await publicClient.readContract({
      address: config.miningAgentAddress,
      abi: miningAgentAbi,
      functionName: "tokenOfOwnerByIndex",
      args: [account.address, 0n],
    })) as bigint;
    const [rarityRaw, hashpowerRaw] = await Promise.all([
      publicClient.readContract({
        address: config.miningAgentAddress,
        abi: miningAgentAbi,
        functionName: "rarity",
        args: [tokenId],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: config.miningAgentAddress,
        abi: miningAgentAbi,
        functionName: "hashpower",
        args: [tokenId],
      }) as Promise<bigint>,
    ]);
    const rarity = Number(rarityRaw);
    const hashpower = Number(hashpowerRaw);
    ui.error("This wallet already owns a mining rig.");
    console.log(`  Rig #${tokenId} — ${rarityLabels[rarity] ?? `Tier ${rarity}`} (${formatHashpower(hashpower)})`);
    console.log("");
    ui.hint("One rig per wallet. Only one mine can succeed per block,");
    ui.hint("so extra rigs in the same wallet waste ETH.");
    ui.hint("To scale: apow wallet new → fund → apow mint");
    return tokenId;
  }

  // Fetch mint price and balance FIRST
  const priceSpinner = ui.spinner("Fetching mint price...");
  const [mintPrice, ethBalance] = await Promise.all([
    publicClient.readContract({
      address: config.miningAgentAddress,
      abi: miningAgentAbi,
      functionName: "getMintPrice",
    }) as Promise<bigint>,
    getEthBalance(),
  ]);
  priceSpinner.stop("Fetching mint price... done");

  // Show price preview
  console.log("");
  ui.table([
    ["Mint price", `${formatEther(mintPrice)} ETH`],
    ["Gas reserve", `${formatEther(MINT_GAS_RESERVE_ETH)} ETH (getChallenge + mint)`],
    ["Required", `${formatEther(mintPrice + MINT_GAS_RESERVE_ETH)} ETH total`],
    ["Balance", `${Number(formatEther(ethBalance)).toFixed(6)} ETH`],
  ]);
  console.log("");

  const requiredBalance = mintPrice + MINT_GAS_RESERVE_ETH;
  if (ethBalance < requiredBalance) {
    ui.error("Insufficient ETH for mint and challenge gas.");
    ui.hint(`Mint uses 2 transactions: getChallenge and mint.`);
    ui.hint(`Send at least ${formatEther(requiredBalance)} ETH to ${account.address} on Base.`);
    return null;
  }

  // Confirm before spending ETH
  const proceed = await ui.confirm("Proceed with mint?");
  if (!proceed) {
    console.log("  Mint cancelled.");
    return null;
  }
  console.log("");

  let receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>> | null = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // Request challenge
    const challengeSpinner = ui.spinner(`Requesting challenge${attempt > 1 ? ` (retry ${attempt}/2)` : ""}...`);
    let challengeReceipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>;
    try {
      const challengeTx = await walletClient.writeContract({
        address: config.miningAgentAddress,
        abi: miningAgentAbi,
        account,
        functionName: "getChallenge",
        args: [account.address],
      });
      challengeReceipt = await publicClient.waitForTransactionReceipt({ hash: challengeTx });
      if (challengeReceipt.status === "reverted") {
        throw new Error("Challenge request reverted on-chain");
      }
    } catch (error) {
      challengeSpinner.fail(`Requesting challenge... failed`);
      throw error;
    }
    challengeSpinner.stop(`Requesting challenge${attempt > 1 ? ` (retry ${attempt}/2)` : ""}... done`);

    // Try reading the seed at the exact receipt block to avoid burning the 20s
    // window waiting for latest-state propagation.  Many public RPCs are NOT
    // archive nodes, so they throw "header not found" for historical blocks —
    // catch that and fall through to latest-state polling.
    let challengeSeed = ZERO_SEED as Hex;
    try {
      challengeSeed = (await publicClient.readContract({
        address: config.miningAgentAddress,
        abi: miningAgentAbi,
        functionName: "challengeSeeds",
        args: [account.address],
        blockNumber: challengeReceipt.blockNumber,
      })) as Hex;
    } catch {
      // Non-archive RPC — fall through to latest-state polling below.
    }

    if (challengeSeed.toLowerCase() === ZERO_SEED.toLowerCase()) {
      // Fall back to latest-state polling if the provider does not expose the
      // just-mined storage view reliably.
      for (let retry = 0; retry < 3; retry++) {
        challengeSeed = (await publicClient.readContract({
          address: config.miningAgentAddress,
          abi: miningAgentAbi,
          functionName: "challengeSeeds",
          args: [account.address],
        })) as Hex;
        if (challengeSeed.toLowerCase() !== ZERO_SEED.toLowerCase()) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    if (challengeSeed.toLowerCase() === ZERO_SEED.toLowerCase()) {
      throw new Error("Challenge seed not found after confirmation. The RPC may be lagging — try again.");
    }

    // Solve SMHL
    const challenge = deriveChallengeFromSeed(challengeSeed);
    const smhlSpinner = ui.spinner("Solving SMHL...");
    let solution: string;
    try {
      solution = await solveSmhlChallenge(challenge, (smhlAttempt) => {
        smhlSpinner.update(`Solving SMHL... attempt ${smhlAttempt}/5`);
      });
    } catch (error) {
      smhlSpinner.fail("Solving SMHL... failed");
      throw error;
    }
    smhlSpinner.stop("Solving SMHL... done");

    // Mint
    const mintSpinner = ui.spinner("Minting...");
    try {
      const mintTx = await walletClient.writeContract({
        address: config.miningAgentAddress,
        abi: miningAgentAbi,
        account,
        functionName: "mint",
        args: [solution],
        value: mintPrice,
      });
      mintSpinner.update("Waiting for confirmation...");
      receipt = await publicClient.waitForTransactionReceipt({ hash: mintTx });
      if (receipt.status === "reverted") {
        throw new Error("Mint transaction reverted on-chain");
      }
      mintSpinner.stop("Minting... confirmed");
      break;
    } catch (error) {
      mintSpinner.fail("Minting... failed");
      if (isExpiredMintError(error) && attempt < 2) {
        ui.warn("Challenge expired before mint submission. Retrying with a fresh challenge...");
        console.log("");
        continue;
      }
      throw error;
    }
  }

  if (!receipt) {
    throw new Error("Mint failed before confirmation.");
  }

  // Parse token ID from Transfer event in receipt (avoids stale RPC reads)
  const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const mintLog = receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === config.miningAgentAddress.toLowerCase() &&
      log.topics[0] === TRANSFER_TOPIC &&
      log.topics[1] === "0x0000000000000000000000000000000000000000000000000000000000000000",
  );
  if (!mintLog || !mintLog.topics[3]) {
    throw new Error("Mint tx confirmed but Transfer event not found in logs. Check tx on Basescan.");
  }
  const tokenId = BigInt(mintLog.topics[3]);

  const [rarityRaw, hashpowerRaw] = await Promise.all([
    publicClient.readContract({
      address: config.miningAgentAddress,
      abi: miningAgentAbi,
      functionName: "rarity",
      args: [tokenId],
    }) as Promise<bigint>,
    publicClient.readContract({
      address: config.miningAgentAddress,
      abi: miningAgentAbi,
      functionName: "hashpower",
      args: [tokenId],
    }) as Promise<bigint>,
  ]);
  const rarity = Number(rarityRaw);
  const hashpower = Number(hashpowerRaw);

  console.log("");
  console.log(`  ${ui.green("Miner #" + tokenId.toString())} — ${rarityLabels[rarity] ?? `Tier ${rarity}`} (${formatHashpower(hashpower)})`);
  console.log(`  Tx: ${ui.dim(txUrl(receipt.transactionHash))}`);
  console.log(`  NFT: ${ui.dim(tokenUrl(config.miningAgentAddress, tokenId))}`);
  console.log("");

  // Offer to start mining
  if (options.startMiningAfterMint === true) {
    await startMining(tokenId);
  } else if (options.startMiningAfterMint !== false) {
    const startMine = await ui.confirm("Start mining?");
    if (startMine) {
      await startMining(tokenId);
    }
  }

  return tokenId;
}
