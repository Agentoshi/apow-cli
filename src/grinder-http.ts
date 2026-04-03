/**
 * HTTP x402 nonce grinder — pay-per-grind GPU mining via GrindProxy.
 *
 * Sends {challenge, target, address} to a remote GPU endpoint (default:
 * grind.apow.io). Payment (dynamic USDC pricing based on GPU cost) is
 * handled automatically via x402 — the server returns 402, the client
 * signs a USDC authorization and retries. No accounts, no API keys.
 *
 * Front-running is cryptographically impossible: nonces are bound to
 * keccak256(challenge, msg.sender, nonce) — a nonce ground for address A
 * is useless for address B.
 */

import type { GrindResult } from "./grinder";
import { config } from "./config";

const DEFAULT_GRIND_URL = "https://grind.apow.io/grind";

// Lazy singleton — created on first grind, reused across calls
let _fetchWithPayment: typeof fetch | null = null;

function resetPaymentFetch(): void {
  _fetchWithPayment = null;
}

async function getPaymentFetch(privateKey: `0x${string}`): Promise<typeof fetch> {
  if (_fetchWithPayment) return _fetchWithPayment;

  const { privateKeyToAccount } = await import("viem/accounts");
  const { x402Client, wrapFetchWithPayment } = await import("@x402/fetch");
  const { registerExactEvmScheme } = await import("@x402/evm/exact/client");

  const signer = privateKeyToAccount(privateKey);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer });

  _fetchWithPayment = wrapFetchWithPayment(fetch, client) as typeof fetch;
  return _fetchWithPayment;
}

export function isHttpGrinderConfigured(): boolean {
  return config.useX402Grind && !!config.privateKey;
}

export function getGrindUrl(): string {
  return config.grindUrl ?? DEFAULT_GRIND_URL;
}

export async function grindNonceHttp(
  challengeNumber: `0x${string}`,
  target: bigint,
  minerAddress: `0x${string}`,
  grindUrl: string,
  privateKey: `0x${string}`,
  signal?: AbortSignal,
): Promise<GrindResult> {
  const start = process.hrtime();
  const requestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      challenge: challengeNumber,
      target: target.toString(),
      address: minerAddress,
    }),
    signal,
  } satisfies RequestInit;

  let response: Response | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const paidFetch = await getPaymentFetch(privateKey);
    response = await paidFetch(grindUrl, requestInit);

    if (response.ok) {
      break;
    }

    const body = await response.text().catch(() => "");
    const paymentRequiredB64 = response.headers.get("payment-required");
    let reason = "";
    if (paymentRequiredB64) {
      try {
        const decoded = JSON.parse(Buffer.from(paymentRequiredB64, "base64").toString());
        reason = decoded.error || "";
      } catch { /* ignore decode errors */ }
    }

    const combinedError = `${reason} ${body}`.trim();
    if (attempt === 1 && combinedError.includes("No matching payment requirements")) {
      resetPaymentFetch();
      continue;
    }

    if (response.status === 402) {
      if (reason.includes("insufficient_balance")) {
        throw new Error("x402 GPU payment failed: insufficient USDC balance");
      } else if (reason.includes("simulation_failed")) {
        throw new Error(`x402 GPU payment failed: EVM simulation failed (USDC approval issue?) [${reason}]`);
      } else {
        throw new Error(`x402 GPU payment failed: ${reason || body.slice(0, 200) || "unknown"}`);
      }
    }
    if (response.status === 504) {
      throw new Error("Remote GPU grind timed out (120s)");
    }
    throw new Error(`GrindProxy HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  if (!response || !response.ok) {
    throw new Error("x402 GPU payment failed: no successful response");
  }

  const data = (await response.json()) as { nonce?: string; elapsed?: number };

  if (!data.nonce) {
    throw new Error("GrindProxy returned no nonce");
  }

  const [s, ns] = process.hrtime(start);
  const totalElapsed = s + ns / 1_000_000_000;

  return {
    nonce: BigInt(data.nonce),
    attempts: 0n, // remote — unknown
    elapsed: data.elapsed ?? totalElapsed,
    hashrate: 0, // remote — unknown
  };
}
