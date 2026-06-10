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

let bootstrapPublicClient = createPublicClient({
  chain: config.chain,
  transport: getBootstrapTransport(),
});

let bootstrapAccount = config.privateKey
  ? privateKeyToAccount(config.privateKey)
  : null;

let bootstrapWalletClient = bootstrapAccount
  ? createWalletClient({
      account: bootstrapAccount,
      chain: config.chain,
      transport: getBootstrapTransport(),
      dataSuffix: DATA_SUFFIX,
    })
  : null;

function shouldUseBootstrapFundingClients(): boolean {
  return config.useX402 && config.chainName === "base" && !!config.rpcUrl;
}

function getBootstrapTransport(): Transport {
  return config.rpcUrl ? http(config.rpcUrl) : transport;
}

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

  bootstrapPublicClient = createPublicClient({
    chain: config.chain,
    transport: getBootstrapTransport(),
  });
  bootstrapAccount = config.privateKey
    ? privateKeyToAccount(config.privateKey)
    : null;
  bootstrapWalletClient = bootstrapAccount
    ? createWalletClient({
        account: bootstrapAccount,
        chain: config.chain,
        transport: getBootstrapTransport(),
        dataSuffix: DATA_SUFFIX,
      })
    : null;
}

export function getFundingClients() {
  if (shouldUseBootstrapFundingClients()) {
    return {
      publicClient: bootstrapPublicClient,
      account: bootstrapAccount,
      walletClient: bootstrapWalletClient,
    };
  }

  return { publicClient, account, walletClient };
}

export function requireWallet() {
  if (!account || !walletClient) {
    throw new Error("Wallet is not configured. Set KEYSTORE_PATH for an encrypted keystore or legacy PRIVATE_KEY in .env.");
  }

  return { account, walletClient };
}

export async function getEthBalance(): Promise<bigint> {
  const { publicClient: balanceClient, account: balanceAccount } = getFundingClients();
  if (!balanceAccount) return 0n;
  return balanceClient.getBalance({ address: balanceAccount.address });
}
