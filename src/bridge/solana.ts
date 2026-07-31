// Solana balance utilities for deposit detection.

const DEFAULT_SOLANA_RPC = "https://api.mainnet-beta.solana.com";

export function getSolanaRpcUrl(): string {
  return process.env.SOLANA_RPC_URL || DEFAULT_SOLANA_RPC;
}

interface SolanaRpcResponse<T> {
  result?: T;
  error?: {
    code?: number;
    message?: string;
  };
}

async function solanaRpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(getSolanaRpcUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  if (!response.ok) {
    throw new Error(`Solana RPC ${method} failed (${response.status})`);
  }

  const body = (await response.json()) as SolanaRpcResponse<T>;
  if (body.error || body.result === undefined) {
    const message = body.error?.message || "missing result";
    throw new Error(`Solana RPC ${method} failed: ${message}`);
  }

  return body.result;
}

/** Get SOL balance for any address (used to detect deposits). */
export async function getAddressBalance(address: string): Promise<number> {
  const result = await solanaRpc<{ value: number }>("getBalance", [
    address,
    { commitment: "confirmed" },
  ]);
  return result.value / 1e9;
}

/** Get SPL token balance (e.g., USDC) for a Solana public key. Returns UI amount (not raw). */
export async function getSplTokenBalance(
  publicKeyBase58: string,
  mintAddress: string,
): Promise<number> {
  const accounts = await solanaRpc<{
    value: Array<{
      account: {
        data: {
          parsed?: {
            info?: {
              tokenAmount?: {
                uiAmount?: number | null;
              };
            };
          };
        };
      };
    }>;
  }>("getTokenAccountsByOwner", [
    publicKeyBase58,
    { mint: mintAddress },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);

  if (accounts.value.length === 0) return 0;
  return accounts.value[0].account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0;
}
