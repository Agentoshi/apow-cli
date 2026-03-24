import { privateKeyToAccount } from "viem/accounts";
import { custom, type Transport } from "viem";

const ALCHEMY_X402_BASE = "https://x402.alchemy.com/rpc/base-mainnet";

let _paidFetch: typeof fetch | null = null;

/* eslint-disable @typescript-eslint/no-require-imports */

function getPaidFetchSync(privateKey: `0x${string}`): typeof fetch {
  if (_paidFetch) return _paidFetch;

  // Use require() to avoid subpath module resolution issues with CommonJS.
  // The x402 packages use `exports` maps which require "node16"/"bundler"
  // moduleResolution — but this project uses classic "Node" resolution.
  const { x402Client } = require("@x402/core/client") as {
    x402Client: new () => { register(network: string, client: unknown): unknown };
  };
  const { ExactEvmScheme } = require("@x402/evm/exact/client") as {
    ExactEvmScheme: new (signer: unknown) => unknown;
  };
  const { toClientEvmSigner } = require("@x402/evm") as {
    toClientEvmSigner: (account: unknown) => unknown;
  };
  const { wrapFetchWithPayment } = require("@x402/fetch") as {
    wrapFetchWithPayment: (f: typeof fetch, client: unknown) => typeof fetch;
  };

  const account = privateKeyToAccount(privateKey);
  const signer = toClientEvmSigner(account);
  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(signer));
  _paidFetch = wrapFetchWithPayment(fetch, client);
  return _paidFetch;
}

export function createX402Transport(privateKey: `0x${string}`): Transport {
  return custom({
    async request({ method, params }) {
      const paidFetch = getPaidFetchSync(privateKey);
      const response = await paidFetch(ALCHEMY_X402_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
      });
      const data = (await response.json()) as {
        result?: unknown;
        error?: { message: string };
      };
      if (data.error) throw new Error(data.error.message);
      return data.result;
    },
  });
}

export function resetX402(): void {
  _paidFetch = null;
}
