/**
 * Multi-threaded nonce grinding via worker_threads.
 * Spawns N workers that search different nonce ranges in parallel.
 * First worker to find a valid nonce wins; all others are terminated.
 */

import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import os from "node:os";
import { encodePacked, keccak256 } from "viem";

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
  onProgress?: (attempts: bigint, hashrate: number) => void;
}

interface WorkerParams {
  challengeNumber: `0x${string}`;
  targetHex: string;
  minerAddress: `0x${string}`;
  startNonce: string;
}

// ── Worker thread logic ──────────────────────────────────────────────

if (!isMainThread && parentPort) {
  const params = workerData as WorkerParams;
  const target = BigInt(params.targetHex);
  let nonce = BigInt(params.startNonce);
  let attempts = 0n;
  const reportInterval = 50_000n;

  while (true) {
    const digest = BigInt(
      keccak256(
        encodePacked(
          ["bytes32", "address", "uint256"],
          [params.challengeNumber, params.minerAddress, nonce],
        ),
      ),
    );

    attempts += 1n;

    if (digest < target) {
      parentPort!.postMessage({
        type: "found",
        nonce: nonce.toString(),
        attempts: attempts.toString(),
      });
      break;
    }

    if (attempts % reportInterval === 0n) {
      parentPort!.postMessage({
        type: "progress",
        attempts: attempts.toString(),
      });
    }

    nonce += 1n;
  }
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

    for (let i = 0; i < threadCount; i++) {
      // Each worker starts at a random offset to avoid overlap
      const startNonce = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));

      const worker = new Worker(__filename, {
        workerData: {
          challengeNumber: params.challengeNumber,
          targetHex: params.target.toString(),
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
