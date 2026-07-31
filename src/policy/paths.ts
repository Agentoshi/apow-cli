import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function ensureApowDir(): string {
  const override = process.env.APOW_DATA_DIR?.trim();
  const dir = override ? resolve(expandHome(override)) : join(homedir(), ".apow");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best effort on filesystems that do not support chmod.
  }
  return dir;
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function policyPath(): string {
  const override = process.env.APOW_POLICY_PATH?.trim();
  return override ? resolve(expandHome(override)) : join(ensureApowDir(), "policy.json");
}

export function auditPath(address: string): string {
  return join(ensureApowDir(), `audit-${address.toLowerCase()}.jsonl`);
}

export function spendPath(address: string): string {
  return join(ensureApowDir(), `spend-${address.toLowerCase()}.jsonl`);
}
