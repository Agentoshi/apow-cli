declare module "@x402/fetch" {
  export class x402Client {}
  export function wrapFetchWithPayment(
    fetch: typeof globalThis.fetch,
    client: x402Client,
  ): typeof globalThis.fetch;
}

declare module "@x402/evm/exact/client" {
  export function registerExactEvmScheme(
    client: import("@x402/fetch").x402Client,
    opts: { signer: unknown },
  ): void;
}
