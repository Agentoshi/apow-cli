import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Address } from "viem";

import { auditPath } from "./paths";

export type AuditKind = "mine" | "mint" | "challenge" | "sweep" | "x402" | "fund-swap" | "eth-send" | "raw-key-handout" | "other";

export interface AuditEntryInput {
  address: Address;
  kind: AuditKind;
  target?: string;
  selector?: string;
  valueWei?: string;
  usdc?: string;
  payee?: string;
  verdict: "allow" | "warn" | "deny";
  policyRule?: string;
  txHash?: string;
  context?: string;
}

type StoredAuditEntry = AuditEntryInput & {
  ts: string;
  seq: number;
  prev: string;
};

function hashLine(line: string): string {
  return `0x${createHash("sha256").update(line).digest("hex")}`;
}

function readLast(path: string): { seq: number; hash: string } {
  if (!existsSync(path)) {
    return { seq: 0, hash: "0x0" };
  }
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    return { seq: 0, hash: "0x0" };
  }
  const last = JSON.parse(lines[lines.length - 1]) as StoredAuditEntry;
  return { seq: last.seq, hash: hashLine(lines[lines.length - 1]) };
}

export function appendAudit(entry: AuditEntryInput): void {
  const path = auditPath(entry.address);
  if (!existsSync(path)) {
    writeFileSync(path, "", { mode: 0o600 });
  }
  const last = readLast(path);
  const stored: StoredAuditEntry = {
    ...entry,
    ts: new Date().toISOString(),
    seq: last.seq + 1,
    prev: last.hash,
  };
  appendFileSync(path, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort.
  }
}

export function verifyAuditChain(path: string): boolean {
  if (!existsSync(path)) return true;
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  let prev = "0x0";
  let seq = 0;
  for (const line of lines) {
    const entry = JSON.parse(line) as StoredAuditEntry;
    seq += 1;
    if (entry.seq !== seq || entry.prev !== prev) {
      return false;
    }
    prev = hashLine(line);
  }
  return true;
}

