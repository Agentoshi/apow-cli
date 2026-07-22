import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatEther, getAddress, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

const WALLET_FILE = "/Users/aklo/mining/wallet-0x4A3F71CF0D4750b67e25Ae7Ef7e38720b3D6e26a.txt";
const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  throw new Error("RPC_URL is required; refusing to use public Base RPC endpoints");
}
const GRIND_URL = "https://grind.apow.io/grind";

const AGENT_COIN = getAddress("0x12577CF0D8a07363224D6909c54C056A183e13b3");
const MINING_AGENT = getAddress("0xB7caD3ca5F2BD8aEC2Eb67d6E8D448099B3bC03D");
const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");

const agentCoinAbi = parseAbi([
  "function getMiningChallenge() view returns (bytes32 challenge, uint256 target, (uint16 targetAsciiSum, uint8 firstNChars, uint8 wordCount, uint8 charPosition, uint8 charValue, uint16 totalLength) smhl)",
  "function mine(uint256 nonce, string smhlSolution, uint256 tokenId)",
  "function balanceOf(address) view returns (uint256)",
  "function tokenEarnings(uint256) view returns (uint256)",
  "function tokenMineCount(uint256) view returns (uint256)",
  "function lastMineBlockNumber() view returns (uint256)",
]);

const miningAgentAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function rarity(uint256) view returns (uint8)",
  "function hashpower(uint256) view returns (uint16)",
]);

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

function parseWallet(filePath) {
  const content = readFileSync(filePath, "utf8");
  const privateKey = content
    .split("\n")
    .find((line) => line.includes("Private Key"))
    ?.split(/:\s*/)[1]
    ?.trim();

  if (!privateKey) {
    throw new Error(`Private key not found in ${filePath}`);
  }

  return privateKey;
}

function solveSmhlAlgorithmic(challenge) {
  const requiredChar = String.fromCharCode(Number(challenge.charValue));
  const targetWords = Number(challenge.wordCount);
  const targetLen = Number(challenge.totalLength);
  const spaces = targetWords - 1;
  const letterBudget = targetLen - spaces;

  if (letterBudget <= 0 || targetWords <= 0) {
    return requiredChar.repeat(Math.max(targetLen, 1));
  }

  const baseWordLen = Math.floor(letterBudget / targetWords);
  const extraChars = letterBudget - baseWordLen * targetWords;

  const words = [];
  for (let i = 0; i < targetWords; i += 1) {
    const len = Math.max(1, baseWordLen + (i < extraChars ? 1 : 0));
    words.push(i === 0 ? requiredChar + "a".repeat(len - 1) : "a".repeat(len));
  }

  return words.join(" ");
}

async function main() {
  const privateKey = parseWallet(WALLET_FILE);
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: base, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(RPC_URL) });

  const x402 = new x402Client();
  registerExactEvmScheme(x402, { signer: account });
  const paidFetch = wrapFetchWithPayment(fetch, x402);

  const [rigCount, usdcBalance, agentBalanceBefore] = await Promise.all([
    publicClient.readContract({
      address: MINING_AGENT,
      abi: miningAgentAbi,
      functionName: "balanceOf",
      args: [account.address],
    }),
    publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    }),
    publicClient.readContract({
      address: AGENT_COIN,
      abi: agentCoinAbi,
      functionName: "balanceOf",
      args: [account.address],
    }),
  ]);

  if (rigCount === 0n) {
    throw new Error(`Wallet ${account.address} owns no mining rigs`);
  }

  const tokenId = await publicClient.readContract({
    address: MINING_AGENT,
    abi: miningAgentAbi,
    functionName: "tokenOfOwnerByIndex",
    args: [account.address, 0n],
  });

  const [rarity, hashpower, earningsBefore, mineCountBefore, miningChallenge] = await Promise.all([
    publicClient.readContract({
      address: MINING_AGENT,
      abi: miningAgentAbi,
      functionName: "rarity",
      args: [tokenId],
    }),
    publicClient.readContract({
      address: MINING_AGENT,
      abi: miningAgentAbi,
      functionName: "hashpower",
      args: [tokenId],
    }),
    publicClient.readContract({
      address: AGENT_COIN,
      abi: agentCoinAbi,
      functionName: "tokenEarnings",
      args: [tokenId],
    }),
    publicClient.readContract({
      address: AGENT_COIN,
      abi: agentCoinAbi,
      functionName: "tokenMineCount",
      args: [tokenId],
    }),
    publicClient.readContract({
      address: AGENT_COIN,
      abi: agentCoinAbi,
      functionName: "getMiningChallenge",
    }),
  ]);

  const [challenge, target, smhl] = miningChallenge;
  const smhlSolution = solveSmhlAlgorithmic(smhl);

  console.log("Wallet:", account.address);
  console.log("Rig:", tokenId.toString(), "| rarity:", Number(rarity), "| hashpower:", Number(hashpower));
  console.log("USDC before:", Number(usdcBalance) / 1e6);
  console.log("AGENT before:", formatEther(agentBalanceBefore));
  console.log("Rig earnings before:", formatEther(earningsBefore), "| mine count before:", mineCountBefore.toString());
  console.log("Challenge:", challenge.slice(0, 18) + "...");
  console.log("Target:", "0x" + target.toString(16).padStart(64, "0").slice(0, 18) + "...");
  console.log("SMHL:", smhlSolution);
  console.log("\nRequesting remote nonce via x402...");

  const grindStart = Date.now();
  const grindResp = await paidFetch(GRIND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      challenge,
      target: target.toString(),
      address: account.address,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const grindElapsedMs = Date.now() - grindStart;

  const grindText = await grindResp.text();
  if (!grindResp.ok) {
    throw new Error(`Grind failed (${grindResp.status}): ${grindText.slice(0, 500)}`);
  }

  const grindData = JSON.parse(grindText);
  if (!grindData.nonce) {
    throw new Error(`No nonce returned: ${grindText.slice(0, 500)}`);
  }

  console.log("Nonce:", grindData.nonce);
  console.log("Remote wall time:", `${(grindElapsedMs / 1000).toFixed(2)}s`);
  console.log("GPU elapsed:", `${grindData.elapsed ?? "?"}s`);
  console.log("\nSubmitting mine()...");

  const txHash = await walletClient.writeContract({
    address: AGENT_COIN,
    abi: agentCoinAbi,
    account,
    functionName: "mine",
    args: [BigInt(grindData.nonce), smhlSolution, tokenId],
  });

  console.log("Tx:", txHash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status === "reverted") {
    throw new Error(`mine() reverted: ${txHash}`);
  }

  const [agentBalanceAfter, earningsAfter, mineCountAfter, usdcBalanceAfter, lastMineBlock] = await Promise.all([
    publicClient.readContract({
      address: AGENT_COIN,
      abi: agentCoinAbi,
      functionName: "balanceOf",
      args: [account.address],
    }),
    publicClient.readContract({
      address: AGENT_COIN,
      abi: agentCoinAbi,
      functionName: "tokenEarnings",
      args: [tokenId],
    }),
    publicClient.readContract({
      address: AGENT_COIN,
      abi: agentCoinAbi,
      functionName: "tokenMineCount",
      args: [tokenId],
    }),
    publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    }),
    publicClient.readContract({
      address: AGENT_COIN,
      abi: agentCoinAbi,
      functionName: "lastMineBlockNumber",
    }),
  ]);

  console.log("\nSUCCESS");
  console.log("Receipt status:", receipt.status);
  console.log("Last mine block:", lastMineBlock.toString());
  console.log("AGENT after:", formatEther(agentBalanceAfter), "| delta:", formatEther(agentBalanceAfter - agentBalanceBefore));
  console.log("Rig earnings after:", formatEther(earningsAfter), "| delta:", formatEther(earningsAfter - earningsBefore));
  console.log("Mine count after:", mineCountAfter.toString(), "| delta:", (mineCountAfter - mineCountBefore).toString());
  console.log("USDC after:", Number(usdcBalanceAfter) / 1e6, "| paid:", Number(usdcBalance - usdcBalanceAfter) / 1e6);
}

main().catch((error) => {
  console.error("\nFAILED");
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
