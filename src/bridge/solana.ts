// Solana wallet utilities — key parsing, balance checks, transaction signing.
// Uses dynamic import() for @solana/web3.js to avoid bloating startup.

const DEFAULT_SOLANA_RPC = "https://api.mainnet-beta.solana.com";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(str: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base58 character: ${char}`);
    let carry = idx;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Preserve leading zeros
  for (const char of str) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

export function getSolanaRpcUrl(): string {
  return process.env.SOLANA_RPC_URL || DEFAULT_SOLANA_RPC;
}

/** Parse a base58-encoded Solana secret key (64 bytes) or seed (32 bytes). */
export async function parseSolanaKey(
  input: string,
): Promise<{ keypair: any; publicKey: string }> {
  const { Keypair } = await import("@solana/web3.js");
  const trimmed = input.trim();

  // Try JSON array format first (Solana CLI keygen output)
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as number[];
      const keypair = Keypair.fromSecretKey(new Uint8Array(arr));
      return { keypair, publicKey: keypair.publicKey.toBase58() };
    } catch {
      throw new Error("Invalid Solana key: looks like JSON but could not parse.");
    }
  }

  // Base58 secret key (Phantom, Backpack export format)
  const decoded = base58Decode(trimmed);

  if (decoded.length === 64) {
    const keypair = Keypair.fromSecretKey(decoded);
    return { keypair, publicKey: keypair.publicKey.toBase58() };
  }

  if (decoded.length === 32) {
    // 32-byte seed
    const keypair = Keypair.fromSeed(decoded);
    return { keypair, publicKey: keypair.publicKey.toBase58() };
  }

  throw new Error(
    `Invalid Solana key: expected 64 bytes (secret key) or 32 bytes (seed), got ${decoded.length}. Provide the full base58-encoded secret key from your wallet.`,
  );
}

/** Get SOL balance for a public key (in SOL, not lamports). */
export async function getSolanaBalance(publicKeyBase58: string): Promise<number> {
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const connection = new Connection(getSolanaRpcUrl(), "confirmed");
  const lamports = await connection.getBalance(new PublicKey(publicKeyBase58));
  return lamports / 1e9;
}

/** Get SOL balance for any address (used to detect deposits). */
export async function getAddressBalance(address: string): Promise<number> {
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const connection = new Connection(getSolanaRpcUrl(), "confirmed");
  const lamports = await connection.getBalance(new PublicKey(address));
  return lamports / 1e9;
}

/** Deserialize, sign, and submit a base64-encoded Solana transaction. */
export async function signAndSendTransaction(
  serializedTxBase64: string,
  keypair: any,
): Promise<string> {
  const { Connection, VersionedTransaction } = await import("@solana/web3.js");
  const connection = new Connection(getSolanaRpcUrl(), "confirmed");

  const txBuffer = Buffer.from(serializedTxBase64, "base64");
  const tx = VersionedTransaction.deserialize(txBuffer);
  tx.sign([keypair]);

  const signature = await connection.sendTransaction(tx, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );

  return signature;
}
