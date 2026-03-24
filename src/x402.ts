import { custom, type Transport } from "viem";
import type { QuicknodeX402Client } from "@quicknode/x402";

const QUICKNODE_BASE = "https://x402.quicknode.com";
const BASE_MAINNET = "eip155:8453";

let _client: QuicknodeX402Client | null = null;

async function getClient(privateKey: `0x${string}`): Promise<QuicknodeX402Client> {
  if (_client && !_client.isTokenExpired()) return _client;

  const { createQuicknodeX402Client } = await import("@quicknode/x402");
  _client = await createQuicknodeX402Client({
    baseUrl: QUICKNODE_BASE,
    network: BASE_MAINNET,
    evmPrivateKey: privateKey,
    preAuth: true,
    // paymentModel defaults to 'credit-drawdown' — no per-request payments
  });
  return _client;
}

export function createX402Transport(privateKey: `0x${string}`): Transport {
  return custom({
    async request({ method, params }) {
      const client = await getClient(privateKey);
      const response = await client.fetch(`${QUICKNODE_BASE}/base-mainnet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
      });

      if (response.status === 402) {
        throw new Error("x402 payment failed — insufficient USDC balance on Base");
      }
      if (!response.ok) {
        throw new Error(`QuickNode x402 HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        result?: unknown;
        error?: { message: string } | string;
      };
      if (data.error) {
        const msg = typeof data.error === "string" ? data.error : data.error.message;
        throw new Error(msg);
      }
      return data.result;
    },
  });
}

export function resetX402(): void {
  _client = null;
}
