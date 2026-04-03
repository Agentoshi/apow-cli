import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import * as ui from "./ui";

const CACHE_DIR = join(os.homedir(), ".apow");
const CACHE_PATH = join(CACHE_DIR, "latest-version.json");
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const PACKAGE_NAME = "apow-cli";

interface VersionCache {
  latest: string;
  checkedAt: number;
}

function parseVersion(value: string): number[] {
  return value
    .replace(/^v/, "")
    .split(".")
    .map((part) => parseInt(part, 10) || 0);
}

function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return false;
}

function readCache(): VersionCache | null {
  if (!existsSync(CACHE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as VersionCache;
  } catch {
    return null;
  }
}

function writeCache(cache: VersionCache): void {
  try {
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }
    writeFileSync(CACHE_PATH, JSON.stringify(cache), "utf8");
  } catch {
    // cache is best-effort only
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const resp = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

export async function warnIfUpdateAvailable(currentVersion: string): Promise<void> {
  const cached = readCache();
  let latest = cached?.latest ?? null;

  if (!cached || Date.now() - cached.checkedAt > CACHE_TTL_MS) {
    const fresh = await fetchLatestVersion();
    if (fresh) {
      latest = fresh;
      writeCache({ latest: fresh, checkedAt: Date.now() });
    }
  }

  if (!latest || !isNewerVersion(latest, currentVersion)) {
    return;
  }

  ui.warn(`Update available: apow-cli ${currentVersion} → ${latest}`);
  ui.hint("Run: npm install -g apow-cli@latest");
  ui.hint(`Or: npx apow-cli@${latest} <command>`);
}
