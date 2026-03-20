// deBridge DLN bridge — direct signing flow (Option A).
// SOL → native ETH on Base in ~20 seconds via DLN market makers.
// No API key needed.

import * as solana from "./solana";

const DLN_API = "https://dln.debridge.finance/v1.0";

const SOLANA_CHAIN_ID = "7565164";
const BASE_CHAIN_ID = "8453";
const NATIVE_SOL = "11111111111111111111111111111111"; // System Program = native SOL
const NATIVE_ETH = "0x0000000000000000000000000000000000000000";

export interface BridgeResult {
  orderId: string;
  txSignature: string;
  status: string;
  timeMs: number;
}

/**
 * Create and submit a deBridge DLN order: SOL → ETH on Base.
 * Returns after the Solana tx is confirmed. Call pollOrderStatus() to wait for fulfillment.
 */
export async function bridgeViaDeBridge(
  solanaKeypair: any,
  baseAddress: string,
  solAmount: number,
): Promise<BridgeResult> {
  const startTime = Date.now();
  const lamports = Math.floor(solAmount * 1e9);
  const srcPublicKey = solanaKeypair.publicKey.toBase58();

  // Step 1: Get serialized bridge transaction from DLN
  const params = new URLSearchParams({
    srcChainId: SOLANA_CHAIN_ID,
    srcChainTokenIn: NATIVE_SOL,
    srcChainTokenInAmount: lamports.toString(),
    dstChainId: BASE_CHAIN_ID,
    dstChainTokenOut: NATIVE_ETH,
    dstChainTokenOutRecipient: baseAddress,
    senderAddress: srcPublicKey,
    srcChainOrderAuthorityAddress: srcPublicKey,
    dstChainOrderAuthorityAddress: baseAddress,
  });

  const response = await fetch(`${DLN_API}/dln/order/create-tx?${params}`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`deBridge API error (${response.status}): ${body}`);
  }

  const data = await response.json() as any;
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

  // Step 2: Sign and submit on Solana
  const txSignature = await solana.signAndSendTransaction(txData, solanaKeypair);

  return {
    orderId,
    txSignature,
    status: "submitted",
    timeMs: Date.now() - startTime,
  };
}

/**
 * Poll deBridge order status until fulfilled, cancelled, or timeout.
 * Default timeout: 5 minutes.
 */
export async function pollOrderStatus(
  orderId: string,
  onUpdate?: (status: string) => void,
  timeoutMs = 300_000,
): Promise<{ status: string; ethReceived?: string }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${DLN_API}/dln/order/${orderId}/status`);
      if (response.ok) {
        const data = await response.json() as any;
        const status: string = data.status || data.orderStatus || "unknown";

        if (onUpdate) onUpdate(status);

        if (
          status === "Fulfilled" ||
          status === "ClaimedUnlock" ||
          status === "SentUnlock"
        ) {
          return {
            status: "fulfilled",
            ethReceived: data.fulfilledDstAmount
              ? (Number(data.fulfilledDstAmount) / 1e18).toFixed(6)
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
