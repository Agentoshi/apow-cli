import type { Abi, Address, Hex } from "viem";
import { formatEther, hexToBytes } from "viem";

import miningAgentAbiJson from "./abi/MiningAgent.json";
import { config } from "./config";
import { txUrl, tokenUrl } from "./explorer";
import { normalizeSmhlChallenge, solveSmhlChallenge, type SmhlChallenge } from "./smhl";
import { formatHashpower } from "./detect";
import { startMining } from "./miner";
import * as ui from "./ui";
import { getEthBalance, publicClient, requireWallet } from "./wallet";

const miningAgentAbi = miningAgentAbiJson as Abi;
const ZERO_SEED = `0x${"0".repeat(64)}` as Hex;
const rarityLabels = ["Common", "Uncommon", "Rare", "Epic", "Mythic"] as const;

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

async function findMintedTokenId(
  startTokenId: bigint,
  endTokenIdExclusive: bigint,
  owner: Address,
  blockNumber: bigint,
): Promise<bigint> {
  for (let tokenId = startTokenId; tokenId < endTokenIdExclusive; tokenId += 1n) {
    try {
      const [tokenOwner, mintBlock] = await Promise.all([
        publicClient.readContract({
          address: config.miningAgentAddress,
          abi: miningAgentAbi,
          functionName: "ownerOf",
          args: [tokenId],
        }) as Promise<Address>,
        publicClient.readContract({
          address: config.miningAgentAddress,
          abi: miningAgentAbi,
          functionName: "mintBlock",
          args: [tokenId],
        }) as Promise<bigint>,
      ]);

      if (tokenOwner.toLowerCase() === owner.toLowerCase() && mintBlock === blockNumber) {
        return tokenId;
      }
    } catch {
      // Ignore missing token ids while scanning the minted window.
    }
  }

  throw new Error("Unable to determine minted token ID from post-mint contract state.");
}

export async function runMintFlow(): Promise<void> {
  const { account, walletClient } = requireWallet();
  console.log("");

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
    return;
  }

  // Confirm before spending ETH
  const proceed = await ui.confirm("Proceed with mint?");
  if (!proceed) {
    console.log("  Mint cancelled.");
    return;
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

  const challengeSeed = (await publicClient.readContract({
    address: config.miningAgentAddress,
    abi: miningAgentAbi,
    functionName: "challengeSeeds",
    args: [account.address],
  })) as Hex;

  if (challengeSeed.toLowerCase() === ZERO_SEED.toLowerCase()) {
    throw new Error("Challenge seed was not stored on-chain.");
  }

  // Solve SMHL
  const challenge = deriveChallengeFromSeed(challengeSeed);
  const smhlSpinner = ui.spinner("Solving SMHL...");
  const solution = await solveSmhlChallenge(challenge, (attempt) => {
    smhlSpinner.update(`Solving SMHL... attempt ${attempt}/3`);
  });
  smhlSpinner.stop("Solving SMHL... done");

  const nextTokenIdBefore = (await publicClient.readContract({
    address: config.miningAgentAddress,
    abi: miningAgentAbi,
    functionName: "nextTokenId",
  })) as bigint;

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

  const nextTokenIdAfter = (await publicClient.readContract({
    address: config.miningAgentAddress,
    abi: miningAgentAbi,
    functionName: "nextTokenId",
  })) as bigint;

  const tokenId = await findMintedTokenId(
    nextTokenIdBefore,
    nextTokenIdAfter,
    account.address,
    receipt.blockNumber,
  );

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
  const startMine = await ui.confirm("Start mining?");
  if (startMine) {
    await startMining(tokenId);
  }
}
