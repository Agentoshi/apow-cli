// deBridge DLN bridge — direct signing flow.
// Supports SOL→Base and Ethereum→Base bridging.
// No API key needed.

import type { Hex } from "viem";
import { createWalletClient, http } from "viem";
import { mainnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { CHAIN_IDS, TOKENS } from "./constants";
import * as solana from "./solana";

const DLN_API = "https://dln.debridge.finance/v1.0";

export interface DeBridgeRoute {
  srcChainId: string;
  srcToken: string;
  srcDecimals: number;
  dstChainId: string;
  dstToken: string;
}

export const ROUTES = {
  sol_to_eth: {
    srcChainId: CHAIN_IDS.solana.debridge,
    srcToken: TOKENS.solana.native,
    srcDecimals: 9,
    dstChainId: CHAIN_IDS.base.debridge,
    dstToken: TOKENS.base.native,
  },
  sol_usdc_to_base_usdc: {
    srcChainId: CHAIN_IDS.solana.debridge,
    srcToken: TOKENS.solana.usdc,
    srcDecimals: 6,
    dstChainId: CHAIN_IDS.base.debridge,
    dstToken: TOKENS.base.usdc,
  },
  eth_to_base_eth: {
    srcChainId: CHAIN_IDS.ethereum.debridge,
    srcToken: TOKENS.ethereum.native,
    srcDecimals: 18,
    dstChainId: CHAIN_IDS.base.debridge,
    dstToken: TOKENS.base.native,
  },
  eth_usdc_to_base_usdc: {
    srcChainId: CHAIN_IDS.ethereum.debridge,
    srcToken: TOKENS.ethereum.usdc,
    srcDecimals: 6,
    dstChainId: CHAIN_IDS.base.debridge,
    dstToken: TOKENS.base.usdc,
  },
} as const;

export interface BridgeResult {
  orderId: string;
  txSignature: string;
  status: string;
  timeMs: number;
}

/**
 * Create DLN order params for any route.
 */
function buildOrderParams(
  route: DeBridgeRoute,
  amount: number,
  senderAddress: string,
  baseAddress: string,
): URLSearchParams {
  const rawAmount = Math.floor(amount * 10 ** route.srcDecimals);
  return new URLSearchParams({
    srcChainId: route.srcChainId,
    srcChainTokenIn: route.srcToken,
    srcChainTokenInAmount: rawAmount.toString(),
    dstChainId: route.dstChainId,
    dstChainTokenOut: route.dstToken,
    dstChainTokenOutRecipient: baseAddress,
    senderAddress,
    srcChainOrderAuthorityAddress: senderAddress,
    dstChainOrderAuthorityAddress: baseAddress,
  });
}

/**
 * Bridge from Solana to Base via deBridge DLN (direct signing).
 * Works for SOL→ETH and USDC→USDC routes.
 */
export async function bridgeFromSolana(
  solanaKeypair: any,
  baseAddress: string,
  amount: number,
  route: DeBridgeRoute = ROUTES.sol_to_eth,
): Promise<BridgeResult> {
  const startTime = Date.now();
  const srcPublicKey = solanaKeypair.publicKey.toBase58();

  const params = buildOrderParams(route, amount, srcPublicKey, baseAddress);

  const response = await fetch(`${DLN_API}/dln/order/create-tx?${params}`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`deBridge API error (${response.status}): ${body}`);
  }

  const data = (await response.json()) as any;
  if (data.errorCode || data.error) {
    throw new Error(
      `deBridge error: ${data.error || data.message || JSON.stringify(data)}`,
    );
  }

  const orderId: string = data.orderId;
  const txData: string | undefined = data.tx?.data;
  if (!txData) {
    throw new Error("deBridge API returned no transaction data");
  }

  const txSignature = await solana.signAndSendTransaction(txData, solanaKeypair);

  return {
    orderId,
    txSignature,
    status: "submitted",
    timeMs: Date.now() - startTime,
  };
}

/**
 * Bridge from Ethereum mainnet to Base via deBridge DLN (direct signing).
 * Uses the same PRIVATE_KEY — same address on all EVM chains.
 * Works for ETH→ETH and USDC→USDC routes.
 */
export async function bridgeFromEvm(
  privateKey: Hex,
  baseAddress: string,
  amount: number,
  route: DeBridgeRoute = ROUTES.eth_to_base_eth,
): Promise<BridgeResult> {
  const startTime = Date.now();
  const evmAccount = privateKeyToAccount(privateKey);
  const rpcUrl = process.env.ETHEREUM_RPC_URL ?? "https://eth.llamarpc.com";

  const ethWalletClient = createWalletClient({
    account: evmAccount,
    chain: mainnet,
    transport: http(rpcUrl),
  });

  const params = buildOrderParams(route, amount, evmAccount.address, baseAddress);

  const response = await fetch(`${DLN_API}/dln/order/create-tx?${params}`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`deBridge API error (${response.status}): ${body}`);
  }

  const data = (await response.json()) as any;
  if (data.errorCode || data.error) {
    throw new Error(
      `deBridge error: ${data.error || data.message || JSON.stringify(data)}`,
    );
  }

  const orderId: string = data.orderId;

  // For EVM, the API returns tx params instead of serialized tx
  const tx = data.tx;
  if (!tx || !tx.to) {
    throw new Error("deBridge API returned no EVM transaction data");
  }

  // For USDC routes, handle token approval if needed
  if (tx.allowanceTarget && tx.allowanceValue) {
    const { createPublicClient } = await import("viem");
    const ethPublicClient = createPublicClient({
      chain: mainnet,
      transport: http(rpcUrl),
    });

    const erc20Abi = [
      {
        type: "function" as const,
        name: "allowance",
        inputs: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
        ],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view" as const,
      },
      {
        type: "function" as const,
        name: "approve",
        inputs: [
          { name: "spender", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
        stateMutability: "nonpayable" as const,
      },
    ] as const;

    const currentAllowance = (await ethPublicClient.readContract({
      address: route.srcToken as `0x${string}`,
      abi: erc20Abi,
      functionName: "allowance",
      args: [evmAccount.address, tx.allowanceTarget as `0x${string}`],
    })) as bigint;

    if (currentAllowance < BigInt(tx.allowanceValue)) {
      const approveTx = await ethWalletClient.writeContract({
        address: route.srcToken as `0x${string}`,
        abi: erc20Abi,
        functionName: "approve",
        args: [tx.allowanceTarget as `0x${string}`, BigInt(tx.allowanceValue)],
      });
      await ethPublicClient.waitForTransactionReceipt({ hash: approveTx });
    }
  }

  const txHash = await ethWalletClient.sendTransaction({
    to: tx.to as `0x${string}`,
    data: tx.data as Hex,
    value: tx.value ? BigInt(tx.value) : 0n,
  });

  return {
    orderId,
    txSignature: txHash,
    status: "submitted",
    timeMs: Date.now() - startTime,
  };
}

/**
 * Poll deBridge order status until fulfilled, cancelled, or timeout.
 * Works for all deBridge orders regardless of source chain.
 */
export async function pollOrderStatus(
  orderId: string,
  onUpdate?: (status: string) => void,
  timeoutMs = 300_000,
): Promise<{ status: string; received?: string; decimals?: number }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${DLN_API}/dln/order/${orderId}/status`);
      if (response.ok) {
        const data = (await response.json()) as any;
        const status: string = data.status || data.orderStatus || "unknown";

        if (onUpdate) onUpdate(status);

        if (
          status === "Fulfilled" ||
          status === "ClaimedUnlock" ||
          status === "SentUnlock"
        ) {
          return {
            status: "fulfilled",
            received: data.fulfilledDstAmount
              ? data.fulfilledDstAmount.toString()
              : undefined,
          };
        }

        if (status === "Cancelled" || status === "CancelledByMaker") {
          throw new Error(`Bridge order was cancelled: ${status}`);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("cancelled")) throw err;
      // Transient fetch error — keep polling
    }

    await new Promise((r) => setTimeout(r, 5000));
  }

  throw new Error(
    "Bridge order timed out after 5 minutes. Check deBridge explorer for order: " +
      orderId,
  );
}
