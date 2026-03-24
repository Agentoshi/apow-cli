// Solana balance utilities for deposit detection.
// Uses dynamic import() for @solana/web3.js to avoid bloating startup.

const DEFAULT_SOLANA_RPC = "https://api.mainnet-beta.solana.com";

export function getSolanaRpcUrl(): string {
  return process.env.SOLANA_RPC_URL || DEFAULT_SOLANA_RPC;
}

/** Get SOL balance for any address (used to detect deposits). */
export async function getAddressBalance(address: string): Promise<number> {
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const connection = new Connection(getSolanaRpcUrl(), "confirmed");
  const lamports = await connection.getBalance(new PublicKey(address));
  return lamports / 1e9;
}

/** Get SPL token balance (e.g., USDC) for a Solana public key. Returns UI amount (not raw). */
export async function getSplTokenBalance(
  publicKeyBase58: string,
  mintAddress: string,
): Promise<number> {
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const connection = new Connection(getSolanaRpcUrl(), "confirmed");
  const owner = new PublicKey(publicKeyBase58);
  const mint = new PublicKey(mintAddress);

  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint });
  if (accounts.value.length === 0) return 0;

  const parsed = accounts.value[0].account.data.parsed;
  return parsed?.info?.tokenAmount?.uiAmount ?? 0;
}
