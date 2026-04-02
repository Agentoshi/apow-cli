/**
 * Multi-threaded nonce grinding via worker_threads.
 * Spawns N workers that search different nonce ranges in parallel.
 * First worker to find a valid nonce wins; all others are terminated.
 *
 * Uses raw buffer operations + @noble/hashes for ~5-15x speedup over
 * the previous viem encodePacked/keccak256 approach.
 */

import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import os from "node:os";

export interface GrindResult {
  nonce: bigint;
  attempts: bigint;
  hashrate: number;
  elapsed: number;
}

export interface GrindParams {
  challengeNumber: `0x${string}`;
  target: bigint;
  minerAddress: `0x${string}`;
  threads?: number;
  signal?: AbortSignal;
  onProgress?: (attempts: bigint, hashrate: number) => void;
}

interface WorkerParams {
  challengeNumber: `0x${string}`;
  targetHex: string;
  minerAddress: `0x${string}`;
  startNonce: string;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ── Worker thread logic ──────────────────────────────────────────────

if (!isMainThread && parentPort) {
  // Dynamic import inside worker to avoid loading at module level in main thread
  import("@noble/hashes/sha3").then(({ keccak_256 }) => {
    const params = workerData as WorkerParams;

    // Pre-allocate the 84-byte input buffer: challenge[32] + address[20] + nonce[32]
    // Layout matches Solidity encodePacked(bytes32, address, uint256)
    const buf = new Uint8Array(84);
    const view = new DataView(buf.buffer);

    // Fill challenge (bytes 0-31) and address (bytes 32-51) once
    const challengeBytes = hexToBytes(params.challengeNumber);
    const addressBytes = hexToBytes(params.minerAddress);
    buf.set(challengeBytes, 0);
    buf.set(addressBytes, 32);

    // Zero the nonce high bytes (bytes 52-75) — we only use low 8 bytes
    buf.fill(0, 52, 76);

    // Convert target to raw bytes for byte-by-byte comparison
    const targetBytes = hexToBytes(params.targetHex.length === 66 ? params.targetHex : "0x" + BigInt(params.targetHex).toString(16).padStart(64, "0"));

    let nonce = Number(params.startNonce);
    let attempts = 0;
    const reportInterval = 100_000;

    while (true) {
      // Write nonce as big-endian uint64 at bytes 76-83
      // (high 24 bytes of the uint256 nonce slot are zeros — fine for the
      // search space we need; Number.MAX_SAFE_INTEGER = 2^53 which is plenty)
      view.setUint32(76, (nonce / 0x100000000) >>> 0, false);
      view.setUint32(80, nonce >>> 0, false);

      // Hash with raw Keccak-256 (returns Uint8Array, no allocations)
      const hash = keccak_256(buf);

      attempts++;

      // Byte-by-byte comparison: hash < target means valid nonce
      let found = false;
      for (let i = 0; i < 32; i++) {
        if (hash[i] < targetBytes[i]) {
          found = true;
          break;
        }
        if (hash[i] > targetBytes[i]) {
          break;
        }
      }

      if (found) {
        // Convert nonce back to BigInt string for the main thread
        const nonceBigInt = BigInt(nonce);
        parentPort!.postMessage({
          type: "found",
          nonce: nonceBigInt.toString(),
          attempts: String(attempts),
        });
        break;
      }

      if (attempts % reportInterval === 0) {
        parentPort!.postMessage({
          type: "progress",
          attempts: String(attempts),
        });
      }

      nonce++;
    }
  });
}

// ── Main thread: spawn workers, collect results ──────────────────────

export async function grindNonceParallel(params: GrindParams): Promise<GrindResult> {
  const threadCount = params.threads ?? os.cpus().length;
  const start = process.hrtime();
  const workers: Worker[] = [];
  const workerAttempts = new Map<number, bigint>();
  let totalAttempts = 0n;

  return new Promise<GrindResult>((resolve, reject) => {
    let settled = false;

    function cleanup() {
      for (const w of workers) {
        w.terminate().catch(() => {});
      }
    }

    function elapsed(): number {
      const [s, ns] = process.hrtime(start);
      return s + ns / 1_000_000_000;
    }

    // Abort signal support — kill all workers if challenge goes stale
    if (params.signal) {
      if (params.signal.aborted) {
        reject(new Error("Grind aborted: challenge stale"));
        return;
      }
      params.signal.addEventListener("abort", () => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error("Grind aborted: challenge stale"));
        }
      }, { once: true });
    }

    for (let i = 0; i < threadCount; i++) {
      // Each worker starts at a random offset to avoid overlap
      const startNonce = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));

      const worker = new Worker(__filename, {
        workerData: {
          challengeNumber: params.challengeNumber,
          targetHex: "0x" + params.target.toString(16).padStart(64, "0"),
          minerAddress: params.minerAddress,
          startNonce: startNonce.toString(),
        } satisfies WorkerParams,
      });

      workerAttempts.set(i, 0n);

      worker.on("message", (msg: { type: string; nonce?: string; attempts?: string }) => {
        if (msg.type === "found" && !settled) {
          settled = true;
          // Sum all worker attempts
          const workerFinalAttempts = BigInt(msg.attempts ?? "0");
          workerAttempts.set(i, workerFinalAttempts);
          totalAttempts = 0n;
          for (const a of workerAttempts.values()) totalAttempts += a;

          const e = elapsed();
          cleanup();
          resolve({
            nonce: BigInt(msg.nonce!),
            attempts: totalAttempts,
            hashrate: e > 0 ? Number(totalAttempts) / e : Number(totalAttempts),
            elapsed: e,
          });
        } else if (msg.type === "progress") {
          const workerProgressAttempts = BigInt(msg.attempts ?? "0");
          workerAttempts.set(i, workerProgressAttempts);
          totalAttempts = 0n;
          for (const a of workerAttempts.values()) totalAttempts += a;

          if (params.onProgress) {
            const e = elapsed();
            const hashrate = e > 0 ? Number(totalAttempts) / e : Number(totalAttempts);
            params.onProgress(totalAttempts, hashrate);
          }
        }
      });

      worker.on("error", (err) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      });

      workers.push(worker);
    }
  });
}
