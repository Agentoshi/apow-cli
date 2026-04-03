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

let transport = getTransport();

export let publicClient = createPublicClient({
  chain: config.chain,
  transport,
});

export let account = config.privateKey
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
  transport = getTransport();
  account = config.privateKey
    ? privateKeyToAccount(config.privateKey)
    : null;
  publicClient = createPublicClient({ chain: config.chain, transport });
  walletClient = account
    ? createWalletClient({
        account,
        chain: config.chain,
        transport,
        dataSuffix: DATA_SUFFIX,
      })
    : null;
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
