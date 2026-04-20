/**
 * ClawRouter x402 LLM proxy lifecycle.
 *
 * Manages an in-process ClawRouter proxy that routes LLM calls through x402,
 * paying for inference with USDC from the agent's existing wallet.
 */

import type { Hex } from "viem";

interface ProxyHandle {
  port: number;
  baseUrl: string;
  walletAddress: string;
  close: () => Promise<void>;
}

let _handle: ProxyHandle | null = null;
let _starting: Promise<ProxyHandle> | null = null;

function importEsmModule<T>(specifier: string): Promise<T> {
  // Keep a real runtime import() so CommonJS builds can load ESM-only packages.
  return Function("specifier", "return import(specifier)")(
    specifier,
  ) as Promise<T>;
}

function getPort(): number {
  const envPort = process.env.CLAWROUTER_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) return parsed;
  }
  return 8402;
}

export function isClawRouterRunning(): boolean {
  return _handle !== null;
}

export function getClawRouterBaseUrl(): string {
  if (_handle) return _handle.baseUrl;
  return `http://127.0.0.1:${getPort()}`;
}

export async function ensureClawRouter(privateKey: Hex): Promise<void> {
  if (_handle) return;

  // Concurrent startup gate — if another call is already starting, wait for it
  if (_starting) {
    await _starting;
    return;
  }

  _starting = (async () => {
    const { startProxy } = await importEsmModule<typeof import("@blockrun/clawrouter")>("@blockrun/clawrouter");
    const port = getPort();

    const handle: ProxyHandle = await startProxy({
      wallet: privateKey,
      port,
      paymentChain: "base",
    });

    _handle = handle;
    return handle;
  })();

  try {
    await _starting;
  } finally {
    _starting = null;
  }
}

export async function stopClawRouter(): Promise<void> {
  if (_handle) {
    await _handle.close();
    _handle = null;
  }
}
