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
const GRIND_HTTP_TIMEOUT_MS = 20_000;

// Lazy singleton — created on first grind, reused across calls
let _fetchWithPayment: typeof fetch | null = null;

function resetPaymentFetch(): void {
  _fetchWithPayment = null;
}

function extractErrorDetail(body: string): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
    if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
    if (body.trim() === "{}") return "";
  } catch {
    // plain text body
  }
  return body.trim();
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
  const timeoutSignal = AbortSignal.timeout(GRIND_HTTP_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const requestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      challenge: challengeNumber,
      target: target.toString(),
      address: minerAddress,
    }),
    signal: requestSignal,
  } satisfies RequestInit;

  let response: Response | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const paidFetch = await getPaymentFetch(privateKey);
    try {
      response = await paidFetch(grindUrl, requestInit);
    } catch (err) {
      if (signal?.aborted) {
        throw err;
      }
      if (timeoutSignal.aborted) {
        resetPaymentFetch();
        throw new Error(`Remote GPU grind timed out (${GRIND_HTTP_TIMEOUT_MS / 1000}s)`);
      }
      resetPaymentFetch();
      if (attempt === 1) {
        continue;
      }
      throw new Error(`Remote GPU grind request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (response.ok) {
      break;
    }

    const body = await response.text().catch(() => "");
    const bodyDetail = extractErrorDetail(body);
    const paymentRequiredB64 = response.headers.get("payment-required");
    let reason = "";
    if (paymentRequiredB64) {
      try {
        const decoded = JSON.parse(Buffer.from(paymentRequiredB64, "base64").toString());
        reason = decoded.error || "";
      } catch { /* ignore decode errors */ }
    }

    const combinedError = `${reason} ${bodyDetail}`.trim();
    const stalePaymentSession = /No matching payment requirements|facilitator|payment session|authorization/i.test(combinedError);
    if (attempt === 1 && (stalePaymentSession || response.status >= 500)) {
      resetPaymentFetch();
      continue;
    }

    if (response.status === 402) {
      resetPaymentFetch();
      if (reason.includes("insufficient_balance")) {
        throw new Error("x402 GPU payment failed: insufficient USDC balance");
      } else if (reason.includes("simulation_failed")) {
        throw new Error(`x402 GPU payment failed: EVM simulation failed (USDC approval issue?) [${reason}]`);
      } else if (attempt === 1) {
        continue;
      } else {
        throw new Error(`x402 GPU payment failed: ${reason || bodyDetail.slice(0, 200) || "unknown"}`);
      }
    }
    if (response.status === 504) {
      throw new Error(`Remote GPU grind timed out (${GRIND_HTTP_TIMEOUT_MS / 1000}s)`);
    }
    throw new Error(`GrindProxy HTTP ${response.status}: ${(bodyDetail || body).slice(0, 200)}`);
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
