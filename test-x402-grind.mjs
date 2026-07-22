import { privateKeyToAccount } from "viem/accounts";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { createPublicClient, http, getAddress, formatUnits } from "viem";
import { base } from "viem/chains";
import { readFileSync } from "fs";

const keyFile = readFileSync("/Users/aklo/mining/wallet-0x4A3F71CF0D4750b67e25Ae7Ef7e38720b3D6e26a.txt", "utf8");
const privateKey = keyFile.split("\n").find(l => l.includes("Private")).split(/:\s*/)[1].trim();
const signer = privateKeyToAccount(privateKey);
console.log("Wallet:", signer.address);

const useSynthetic = process.env.SYNTHETIC_GRIND === "true";
const RPC_URL = process.env.RPC_URL;
if (!RPC_URL && !useSynthetic) {
  throw new Error("RPC_URL is required; refusing to use public Base RPC endpoints");
}
const pub = RPC_URL ? createPublicClient({ chain: base, transport: http(RPC_URL) }) : null;
const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const AgentCoin = getAddress("0x12577CF0D8a07363224D6909c54C056A183e13b3");
const abi = JSON.parse(readFileSync("./src/abi/AgentCoin.json", "utf8"));

let bal = 0n;
let challengeHex = "0x" + "11".repeat(32);
let target = (2n ** 256n) - 1n;
if (pub) {
  const [balBefore, challengeData, miningTarget] = await Promise.all([
    pub.readContract({ address: USDC, abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [signer.address] }),
    pub.readContract({ address: AgentCoin, abi, functionName: "getMiningChallenge" }),
    pub.readContract({ address: AgentCoin, abi, functionName: "miningTarget" }),
  ]);
  bal = balBefore;
  // getMiningChallenge returns [bytes32, uint256, tuple] — bytes32 is already 0x-prefixed hex string
  challengeHex = challengeData[0];
  target = miningTarget;
  console.log("USDC:", formatUnits(bal, 6));
} else {
  console.log("Synthetic mode: skipping client-side RPC and balance checks");
}
console.log("Challenge:", challengeHex.slice(0, 20) + "...");
console.log("Target:", "0x" + target.toString(16).padStart(64, "0").slice(0, 20) + "...");

// x402 client
const client = new x402Client();
registerExactEvmScheme(client, { signer });
const paidFetch = wrapFetchWithPayment(fetch, client);

// Health
const health = await (await fetch("https://grind.apow.io/health")).json();
console.log("\nHealth:", JSON.stringify(health));

// Grind
console.log("\n--- Sending x402 Grind Request ---");
const start = Date.now();
try {
  const resp = await paidFetch("https://grind.apow.io/grind", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challenge: challengeHex, target: target.toString(), address: signer.address }),
  });
  const elapsed = Date.now() - start;
  console.log("Status:", resp.status, `(${elapsed}ms)`);

  if (resp.headers.get("payment-required")) {
    try {
      const decoded = JSON.parse(Buffer.from(resp.headers.get("payment-required"), "base64").toString());
      console.log("Payment-Required:", JSON.stringify(decoded, null, 2));
    } catch {}
  }

  const body = await resp.text();
  try { console.log("Body:", JSON.stringify(JSON.parse(body), null, 2)); }
  catch { console.log("Body:", body.slice(0, 500)); }

  if (pub) {
    const balAfter = await pub.readContract({ address: USDC, abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [signer.address] });
    const paid = bal - balAfter;
    console.log(paid > 0n ? `\nPaid: ${formatUnits(paid, 6)} USDC | Balance: ${formatUnits(balAfter, 6)}` : "\nNo USDC charged");
  } else {
    console.log("\nPaid amount: verify through D1 ledger and service-wallet receipts");
  }
  console.log(resp.status === 200 ? "\n✅ x402 GRIND SUCCEEDED!" : `\n❌ Grind failed (${resp.status})`);
} catch (err) {
  console.error("Error:", err.message);
}
