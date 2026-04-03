import type { Abi, Hex } from "viem";
import { formatEther, hexToBytes } from "viem";

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

export interface MintFlowOptions {
  startMiningAfterMint?: boolean;
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
    ["Balance", `${Number(formatEther(ethBalance)).toFixed(6)} ETH`],
  ]);
  console.log("");

  if (ethBalance < mintPrice) {
    ui.error("Insufficient ETH for mint.");
    ui.hint(`Send at least ${formatEther(mintPrice)} ETH to ${account.address} on Base`);
    return null;
  }

  // Confirm before spending ETH
  const proceed = await ui.confirm("Proceed with mint?");
  if (!proceed) {
    console.log("  Mint cancelled.");
    return null;
  }
  console.log("");

  // Request challenge
  const challengeSpinner = ui.spinner("Requesting challenge...");
  const challengeTx = await walletClient.writeContract({
    address: config.miningAgentAddress,
    abi: miningAgentAbi,
    account,
    functionName: "getChallenge",
    args: [account.address],
  });
  const challengeReceipt = await publicClient.waitForTransactionReceipt({ hash: challengeTx });
  if (challengeReceipt.status === "reverted") {
    throw new Error("Challenge request reverted on-chain");
  }
  challengeSpinner.stop("Requesting challenge... done");

  // Read challenge seed with retry (public RPC may lag behind tx confirmation)
  let challengeSeed: Hex = ZERO_SEED;
  for (let retry = 0; retry < 5; retry++) {
    challengeSeed = (await publicClient.readContract({
      address: config.miningAgentAddress,
      abi: miningAgentAbi,
      functionName: "challengeSeeds",
      args: [account.address],
    })) as Hex;
    if (challengeSeed.toLowerCase() !== ZERO_SEED.toLowerCase()) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (challengeSeed.toLowerCase() === ZERO_SEED.toLowerCase()) {
    throw new Error("Challenge seed not found after 5 retries. The RPC may be lagging — try again.");
  }

  // Solve SMHL
  const challenge = deriveChallengeFromSeed(challengeSeed);
  const smhlSpinner = ui.spinner("Solving SMHL...");
  const solution = await solveSmhlChallenge(challenge, (attempt) => {
    smhlSpinner.update(`Solving SMHL... attempt ${attempt}/5`);
  });
  smhlSpinner.stop("Solving SMHL... done");

  // Mint
  const mintSpinner = ui.spinner("Minting...");
  const mintTx = await walletClient.writeContract({
    address: config.miningAgentAddress,
    abi: miningAgentAbi,
    account,
    functionName: "mint",
    args: [solution],
    value: mintPrice,
  });
  mintSpinner.update("Waiting for confirmation...");
  const receipt = await publicClient.waitForTransactionReceipt({ hash: mintTx });
  if (receipt.status === "reverted") {
    throw new Error("Mint transaction reverted on-chain");
  }
  mintSpinner.stop("Minting... confirmed");

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
