/**
 * Build native grinder binaries for GPU/CPU mining.
 *
 * Auto-detects available compilers and GPU architecture, then compiles
 * whichever grinders are possible on the current platform:
 *   - CPU-C (any platform with clang or gcc)
 *   - CUDA (Linux/Windows with nvcc + NVIDIA GPU)
 *   - Metal (macOS with clang)
 *
 * Installs compiled binaries to ~/.apow/ where auto-detection will find them.
 */

import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";
import * as ui from "./ui";

const INSTALL_DIR = join(os.homedir(), ".apow");

interface BuildResult {
  name: string;
  success: boolean;
  path?: string;
  error?: string;
}

function findSourceDir(): string | null {
  // Check relative to this file's compiled location (dist/)
  const fromDist = join(dirname(__dirname), "local", "gpu");
  if (existsSync(join(fromDist, "grinder-cpu.c"))) return fromDist;

  // Check CWD (git clone case)
  const fromCwd = join(process.cwd(), "local", "gpu");
  if (existsSync(join(fromCwd, "grinder-cpu.c"))) return fromCwd;

  const fromCwdGpu = join(process.cwd(), "gpu");
  if (existsSync(join(fromCwdGpu, "grinder-cpu.c"))) return fromCwdGpu;

  return null;
}

function which(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function detectCudaArch(): string | null {
  try {
    const raw = execSync(
      "nvidia-smi --query-gpu=compute_cap --format=csv,noheader",
      { encoding: "utf8", timeout: 5000 },
    ).trim();
    // e.g. "8.9" → "sm_89"
    const first = raw.split("\n")[0].trim();
    if (/^\d+\.\d+$/.test(first)) {
      return "sm_" + first.replace(".", "");
    }
  } catch {}
  return null;
}

function buildCpuC(sourceDir: string): BuildResult {
  const src = join(sourceDir, "grinder-cpu.c");
  const out = join(INSTALL_DIR, "grinder-cpu");
  const name = "CPU-C";

  if (!existsSync(src)) {
    return { name, success: false, error: "source file not found" };
  }

  // Prefer clang, fall back to gcc
  const cc = which("clang") ? "clang" : which("gcc") ? "gcc" : null;
  if (!cc) {
    return { name, success: false, error: "no C compiler found (need clang or gcc)" };
  }

  try {
    execSync(`${cc} -O2 -pthread "${src}" -o "${out}"`, {
      stdio: "pipe",
      timeout: 60000,
    });
    chmodSync(out, 0o755);
    return { name, success: true, path: out };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name, success: false, error: msg.split("\n")[0] };
  }
}

function buildCuda(sourceDir: string, archOverride?: string): BuildResult {
  const src = join(sourceDir, "grinder-cuda.cu");
  const out = join(INSTALL_DIR, "grinder-cuda");
  const name = "CUDA";

  if (!existsSync(src)) {
    return { name, success: false, error: "source file not found" };
  }

  if (!which("nvcc")) {
    return { name, success: false, error: "nvcc not found (install CUDA toolkit)" };
  }

  const arch = archOverride ?? detectCudaArch() ?? "sm_89";

  try {
    execSync(
      `nvcc "${src}" -o "${out}" -std=c++17 -O3 -arch=${arch}`,
      { stdio: "pipe", timeout: 120000 },
    );
    chmodSync(out, 0o755);
    return { name: `CUDA (${arch})`, success: true, path: out };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name, success: false, error: msg.split("\n")[0] };
  }
}

function buildMetal(sourceDir: string): BuildResult {
  const src = join(sourceDir, "grinder.m");
  const out = join(INSTALL_DIR, "grinder-gpu");
  const name = "Metal GPU";

  if (process.platform !== "darwin") {
    return { name, success: false, error: "macOS only" };
  }

  if (!existsSync(src)) {
    return { name, success: false, error: "source file not found" };
  }

  if (!which("clang")) {
    return { name, success: false, error: "clang not found (install Xcode CLI tools)" };
  }

  try {
    execSync(
      `clang -O2 -framework Metal -framework Foundation "${src}" -o "${out}"`,
      { stdio: "pipe", timeout: 60000 },
    );
    chmodSync(out, 0o755);
    // Copy Metal shader alongside binary — grinder loads it at runtime from CWD
    const shader = join(sourceDir, "keccak.metal");
    if (existsSync(shader)) {
      copyFileSync(shader, join(INSTALL_DIR, "keccak.metal"));
    }
    return { name, success: true, path: out };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name, success: false, error: msg.split("\n")[0] };
  }
}

export async function buildGrinders(opts: { cudaArch?: string }): Promise<void> {
  console.log("");
  ui.banner(["Build Native Grinders"]);
  console.log("");

  // Find source files
  const sourceDir = findSourceDir();
  if (!sourceDir) {
    ui.error("Grinder source files not found.");
    ui.hint("Ensure local/gpu/ exists (included in npm package since v0.9.2)");
    return;
  }
  console.log(`  Source: ${ui.dim(sourceDir)}`);

  // Create install directory
  if (!existsSync(INSTALL_DIR)) {
    mkdirSync(INSTALL_DIR, { recursive: true });
  }
  console.log(`  Install: ${ui.dim(INSTALL_DIR)}`);
  console.log("");

  // Build each grinder
  const results: BuildResult[] = [];

  const cpuSpinner = ui.spinner("Building CPU-C grinder...");
  const cpuResult = buildCpuC(sourceDir);
  results.push(cpuResult);
  if (cpuResult.success) {
    cpuSpinner.stop(`Building CPU-C grinder... ${ui.green("OK")}`);
  } else {
    cpuSpinner.stop(`Building CPU-C grinder... ${ui.yellow("skipped")} (${cpuResult.error})`);
  }

  const cudaSpinner = ui.spinner("Building CUDA grinder...");
  const cudaResult = buildCuda(sourceDir, opts.cudaArch);
  results.push(cudaResult);
  if (cudaResult.success) {
    cudaSpinner.stop(`Building CUDA grinder... ${ui.green("OK")}`);
  } else {
    cudaSpinner.stop(`Building CUDA grinder... ${ui.yellow("skipped")} (${cudaResult.error})`);
  }

  const metalSpinner = ui.spinner("Building Metal GPU grinder...");
  const metalResult = buildMetal(sourceDir);
  results.push(metalResult);
  if (metalResult.success) {
    metalSpinner.stop(`Building Metal GPU grinder... ${ui.green("OK")}`);
  } else {
    metalSpinner.stop(`Building Metal GPU grinder... ${ui.yellow("skipped")} (${metalResult.error})`);
  }

  // Summary
  console.log("");
  const built = results.filter((r) => r.success);
  if (built.length === 0) {
    ui.warn("No grinders could be built on this system.");
    console.log("");
    console.log(`  ${ui.dim("Requirements:")}`);
    console.log(`  ${ui.dim("  CPU-C:  clang or gcc")}`);
    console.log(`  ${ui.dim("  CUDA:   nvcc + NVIDIA GPU (nvidia-smi)")}`);
    console.log(`  ${ui.dim("  Metal:  macOS + Xcode CLI tools")}`);
  } else {
    ui.ok(`Built ${built.length} grinder${built.length > 1 ? "s" : ""}:`);
    for (const r of built) {
      console.log(`    ${ui.green(r.name)} → ${ui.dim(r.path!)}`);
    }
    console.log("");
    console.log(`  Grinders installed to ${ui.cyan("~/.apow/")} — auto-detected on next mine.`);
    console.log(`  Run ${ui.cyan("apow mine")} to start GPU mining.`);
  }
  console.log("");
}
