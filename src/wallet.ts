import { createPublicClient, createWalletClient, http, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Attribution } from "ox/erc8021";

import { config } from "./config";
import { createX402Transport } from "./x402";

const DATA_SUFFIX = Attribution.toDataSuffix({ codes: ["bc_6wfeb1kd"] });

function getTransport(): Transport {
  if (config.useX402 && config.privateKey) {
    return createX402Transport(config.privateKey);
  }
  return http(config.rpcUrl);
}

const transport = getTransport();

export let publicClient = createPublicClient({
  chain: config.chain,
  transport,
});

export const account = config.privateKey
  ? privateKeyToAccount(config.privateKey)
  : null;

export let walletClient = account
  ? createWalletClient({
      account,
      chain: config.chain,
      transport,
      dataSuffix: DATA_SUFFIX,
    })
  : null;

/** Reinitialize clients after config changes (e.g., x402 fallback). */
export function reinitClients(): void {
  const t = getTransport();
  publicClient = createPublicClient({ chain: config.chain, transport: t });
  if (account) {
    walletClient = createWalletClient({
      account,
      chain: config.chain,
      transport: t,
      dataSuffix: DATA_SUFFIX,
    });
  }
}

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
