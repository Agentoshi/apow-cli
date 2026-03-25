/**
 * Native GPU/CPU nonce grinder integration.
 *
 * Detects and spawns native grinder binaries (Metal, CPU-C, CUDA) for
 * dramatically faster nonce grinding compared to JS worker_threads.
 *
 * Supported grinders:
 *   - Metal (macOS Apple Silicon): local GPU, ~260-500 MH/s
 *   - CPU-C (any platform): multi-threaded C, ~150-300 MH/s
 *   - CUDA (remote via SSH): Vast.ai RTX 4090, ~20 GH/s
 *
 * All grinders race in parallel. First valid nonce wins; others are killed.
 *
 * Binary interface:
 *   Metal/CPU: ./grinder <challenge> <address> <target> [threads]
 *              stdout: <nonce> <attempts> <elapsed_seconds>
 *
 *   CUDA:      ./grinder-cuda <challenge> <target> <address>
 *              stdout: F <addr_index> <nonce> <elapsed_seconds>
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { config } from "./config";
import type { GrindResult } from "./grinder";

export interface GrinderInfo {
  gpu: string | null;
  cuda: string | null;
  cpu: string | null;
  remoteGpu: boolean;
}

/**
 * Detect available native grinder binaries.
 * Checks: explicit env var > ./gpu/ > ./ > ~/.apow/
 */
export function detectGrinders(): GrinderInfo {
  return {
    gpu: detectLocalGpu(),
    cuda: detectLocalCuda(),
    cpu: detectLocalCpu(),
    remoteGpu: !!(config.vastIp && config.vastPort),
  };
}

function detectLocalGpu(): string | null {
  if (config.gpuGrinderPath) {
    return existsSync(config.gpuGrinderPath) ? config.gpuGrinderPath : null;
  }
  if (process.platform !== "darwin") return null;

  const candidates = [
    join(process.cwd(), "gpu", "grinder-gpu"),
    join(process.cwd(), "local", "gpu", "grinder-gpu"),
    join(process.cwd(), "grinder-gpu"),
    join(os.homedir(), ".apow", "grinder-gpu"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function detectLocalCuda(): string | null {
  if (config.cudaGrinderPath) {
    return existsSync(config.cudaGrinderPath) ? config.cudaGrinderPath : null;
  }

  const candidates = [
    join(process.cwd(), "gpu", "grinder-cuda"),
    join(process.cwd(), "local", "gpu", "grinder-cuda"),
    join(process.cwd(), "grinder-cuda"),
    join(os.homedir(), ".apow", "grinder-cuda"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function detectLocalCpu(): string | null {
  if (config.cpuGrinderPath) {
    return existsSync(config.cpuGrinderPath) ? config.cpuGrinderPath : null;
  }

  const candidates = [
    join(process.cwd(), "gpu", "grinder-cpu"),
    join(process.cwd(), "local", "gpu", "grinder-cpu"),
    join(process.cwd(), "grinder-cpu"),
    join(os.homedir(), ".apow", "grinder-cpu"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function hasNativeGrinders(info: GrinderInfo): boolean {
  return !!(info.gpu || info.cuda || info.cpu || info.remoteGpu);
}

export function grinderLabel(info: GrinderInfo): string {
  const parts: string[] = [];
  if (info.remoteGpu) parts.push("CUDA (remote)");
  if (info.cuda) parts.push("CUDA GPU");
  if (info.gpu) parts.push(process.platform === "darwin" ? "Metal GPU" : "GPU");
  if (info.cpu) parts.push(`CPU-C (${config.cpuGrinderThreads}t)`);
  if (parts.length === 0) return "JS worker_threads";
  return parts.join(" + ");
}

/**
 * Grind nonce using all available native grinders in parallel.
 * First to find a valid nonce wins; all others are killed.
 */
export async function grindNonceNative(
  challengeNumber: `0x${string}`,
  target: bigint,
  minerAddress: `0x${string}`,
  info: GrinderInfo,
  signal?: AbortSignal,
): Promise<GrindResult> {
  const targetHex = "0x" + target.toString(16).padStart(64, "0");
  const processes: ChildProcess[] = [];
  const start = process.hrtime();

  return new Promise<GrindResult>((resolve, reject) => {
    let settled = false;
    let failCount = 0;
    let totalGrinders = 0;

    function elapsed(): number {
      const [s, ns] = process.hrtime(start);
      return s + ns / 1_000_000_000;
    }

    function cleanup() {
      for (const proc of processes) {
        try { proc.kill("SIGTERM"); } catch {}
      }
      if (info.remoteGpu) {
        try {
          const kp = spawn("ssh", [
            "-o", "StrictHostKeyChecking=no",
            "-o", "ConnectTimeout=5",
            "-p", config.vastPort!,
            `root@${config.vastIp}`,
            "pkill -9 grinder-cuda 2>/dev/null",
          ]);
          setTimeout(() => { try { kp.kill(); } catch {} }, 5000);
        } catch {}
      }
    }

    // Abort signal support — kill all grinder processes if challenge goes stale
    if (signal) {
      if (signal.aborted) {
        reject(new Error("Grind aborted: challenge stale"));
        return;
      }
      signal.addEventListener("abort", () => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error("Grind aborted: challenge stale"));
        }
      }, { once: true });
    }

    function onResult(result: GrindResult) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    function onFail() {
      failCount++;
      if (failCount >= totalGrinders && !settled) {
        settled = true;
        cleanup();
        reject(new Error("All native grinders failed to find a nonce"));
      }
    }

    // Local Metal GPU
    if (info.gpu) {
      totalGrinders++;
      const proc = spawn(info.gpu, [challengeNumber, minerAddress, targetHex]);
      processes.push(proc);

      let stdout = "";
      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.on("close", (code) => {
        if (settled) return;
        if (code === 0) {
          const parts = stdout.trim().split(/\s+/);
          if (parts.length >= 3) {
            const attempts = BigInt(parts[1]);
            const e = parseFloat(parts[2]);
            onResult({
              nonce: BigInt(parts[0]),
              attempts,
              elapsed: e,
              hashrate: e > 0 ? Number(attempts) / e : 0,
            });
            return;
          }
        }
        onFail();
      });
      proc.on("error", () => onFail());
    }

    // Local CUDA GPU
    if (info.cuda) {
      totalGrinders++;
      // CUDA arg order: <challenge> <target> <address>
      const proc = spawn(info.cuda, [challengeNumber, targetHex, minerAddress]);
      processes.push(proc);

      let buf = "";
      proc.stdout.on("data", (d) => {
        if (settled) return;
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line.startsWith("F ")) {
            const parts = line.split(/\s+/);
            if (parts.length >= 4) {
              const e = parseFloat(parts[3]);
              onResult({
                nonce: BigInt(parts[2]),
                attempts: 0n,
                elapsed: e,
                hashrate: 0,
              });
              return;
            }
          }
        }
      });
      proc.on("close", () => {
        if (!settled) onFail();
      });
      proc.on("error", () => onFail());
    }

    // Local CPU-C
    if (info.cpu) {
      totalGrinders++;
      const proc = spawn(info.cpu, [
        challengeNumber, minerAddress, targetHex,
        String(config.cpuGrinderThreads),
      ]);
      processes.push(proc);

      let stdout = "";
      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.on("close", (code) => {
        if (settled) return;
        if (code === 0) {
          const parts = stdout.trim().split(/\s+/);
          if (parts.length >= 3) {
            const attempts = BigInt(parts[1]);
            const e = parseFloat(parts[2]);
            onResult({
              nonce: BigInt(parts[0]),
              attempts,
              elapsed: e,
              hashrate: e > 0 ? Number(attempts) / e : 0,
            });
            return;
          }
        }
        onFail();
      });
      proc.on("error", () => onFail());
    }

    // Remote CUDA via SSH
    if (info.remoteGpu) {
      totalGrinders++;
      // CUDA arg order differs: <challenge> <target> <address>
      const proc = spawn("ssh", [
        "-o", "StrictHostKeyChecking=no",
        "-o", "ConnectTimeout=10",
        "-o", "ServerAliveInterval=30",
        "-p", config.vastPort!,
        `root@${config.vastIp}`,
        `${config.remoteGrinderPath} ${challengeNumber} ${targetHex} ${minerAddress}`,
      ]);
      processes.push(proc);

      let buf = "";
      proc.stdout.on("data", (d) => {
        if (settled) return;
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line.startsWith("F ")) {
            const parts = line.split(/\s+/);
            if (parts.length >= 4) {
              const e = parseFloat(parts[3]);
              onResult({
                nonce: BigInt(parts[2]),
                attempts: 0n,
                elapsed: e,
                hashrate: 0,
              });
              return;
            }
          }
        }
      });
      proc.on("close", () => {
        if (!settled) onFail();
      });
      proc.on("error", () => onFail());
    }

    if (totalGrinders === 0) {
      reject(new Error("No native grinders available"));
    }
  });
}
