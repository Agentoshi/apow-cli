import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { config } from "./config";

export const publicClient = createPublicClient({
  chain: config.chain,
  transport: http(config.rpcUrl),
});

export const account = config.privateKey
  ? privateKeyToAccount(config.privateKey)
  : null;

export const walletClient = account
  ? createWalletClient({
      account,
      chain: config.chain,
      transport: http(config.rpcUrl),
    })
  : null;

export function requireWallet() {
  if (!account || !walletClient) {
    throw new Error("Wallet is not configured. Set PRIVATE_KEY in .env.");
  }

  return { account, walletClient };
}

export async function getEthBalance(): Promise<bigint> {
  if (!account) return 0n;
  return publicClient.getBalance({ address: account.address });
}
