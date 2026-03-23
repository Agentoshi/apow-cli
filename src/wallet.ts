import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Attribution } from "ox/erc8021";

import { config } from "./config";

const DATA_SUFFIX = Attribution.toDataSuffix({ codes: ["bc_6wfeb1kd"] });

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
      dataSuffix: DATA_SUFFIX,
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
