import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Address } from "viem";

import { spendPath } from "./paths";

export interface SpendEntry {
  address: Address;
  kind: "x402";
  usdc: number;
  payee?: Address;
}

type StoredSpendEntry = SpendEntry & {
  ts: string;
  day: string;
};

function utcDay(ts = new Date()): string {
  return ts.toISOString().slice(0, 10);
}

export function recordSpend(entry: SpendEntry): void {
  const path = spendPath(entry.address);
  if (!existsSync(path)) {
    writeFileSync(path, "", { mode: 0o600 });
  }
  const stored: StoredSpendEntry = { ...entry, ts: new Date().toISOString(), day: utcDay() };
  appendFileSync(path, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort.
  }
}

export function spentTodayUsdc(address: Address): number {
  const path = spendPath(address);
  if (!existsSync(path)) return 0;
  const day = utcDay();
  let total = 0;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as StoredSpendEntry;
      if (entry.day === day) total += Number(entry.usdc) || 0;
    } catch {
      // Ignore malformed historical rows.
    }
  }
  return total;
}

