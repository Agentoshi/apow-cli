import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { Keystore } from "ox";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const GENERATED_WALLETS_VERSION = 1;

export interface GeneratedWalletRecord {
  address: `0x${string}`;
  keystorePath: string;
  createdAt: string;
}

interface GeneratedWalletRegistry {
  version: typeof GENERATED_WALLETS_VERSION;
  wallets: GeneratedWalletRecord[];
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best-effort permissions hardening; some filesystems do not support chmod.
  }
}

function getDefaultApowDir(): string {
  return join(homedir(), ".apow");
}

export function getKeystoreDir(apowDir = getDefaultApowDir()): string {
  const dir = join(apowDir, "keystores");
  ensureDir(dir);
  return dir;
}

export function getKeystoreWalletPath(address: string, apowDir = getDefaultApowDir()): string {
  return join(getKeystoreDir(apowDir), `wallet-${address}.json`);
}

export function getGeneratedWalletsPath(apowDir = getDefaultApowDir()): string {
  return join(apowDir, "generated-wallets.json");
}

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function resolveKeystorePath(path: string): string {
  const expanded = expandHomePath(path);
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

export async function saveEncryptedKeystoreFile(
  address: `0x${string}`,
  privateKey: `0x${string}`,
  password: string,
  apowDir = getDefaultApowDir(),
): Promise<string> {
  const filepath = getKeystoreWalletPath(address, apowDir);
  const [key, opts] = await Keystore.scryptAsync({ password });
  const keystore = Keystore.encrypt(privateKey, key, opts);
  const payload = {
    ...keystore,
    address: address.slice(2).toLowerCase(),
  };
  writeFileSync(filepath, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(filepath, 0o600);
  } catch {
    // Best-effort permissions hardening.
  }
  return filepath;
}

export function registerGeneratedWallet(
  address: `0x${string}`,
  keystorePath: string,
  apowDir = getDefaultApowDir(),
): void {
  if (!ADDRESS_RE.test(address)) {
    throw new Error("Cannot register an invalid generated wallet address.");
  }

  const expectedKeystorePath = resolve(getKeystoreWalletPath(address, apowDir));
  if (resolve(keystorePath) !== expectedKeystorePath || !existsSync(expectedKeystorePath)) {
    throw new Error("Generated wallet registration requires its local APoW encrypted keystore.");
  }

  const registryPath = getGeneratedWalletsPath(apowDir);
  ensureDir(apowDir);

  const existing = loadGeneratedWalletRegistry(apowDir);
  const withoutDuplicate = existing.wallets.filter(
    (wallet) => wallet.address.toLowerCase() !== address.toLowerCase(),
  );
  const registry: GeneratedWalletRegistry = {
    version: GENERATED_WALLETS_VERSION,
    wallets: [
      ...withoutDuplicate,
      {
        address,
        keystorePath: expectedKeystorePath,
        createdAt: new Date().toISOString(),
      },
    ],
  };

  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(registryPath, 0o600);
  } catch {
    // Best-effort permissions hardening.
  }
}

export function loadGeneratedWallets(apowDir = getDefaultApowDir()): GeneratedWalletRecord[] {
  return loadGeneratedWalletRegistry(apowDir).wallets.flatMap((wallet) => {
    if (!ADDRESS_RE.test(wallet.address)) return [];
    const expectedKeystorePath = resolve(getKeystoreWalletPath(wallet.address, apowDir));
    if (resolve(wallet.keystorePath) !== expectedKeystorePath || !existsSync(expectedKeystorePath)) {
      return [];
    }
    return [{
      address: wallet.address,
      keystorePath: expectedKeystorePath,
      createdAt: wallet.createdAt,
    }];
  });
}

export function loadGeneratedWalletAddresses(apowDir = getDefaultApowDir()): `0x${string}`[] {
  return loadGeneratedWallets(apowDir).map((wallet) => wallet.address);
}

export function loadEncryptedKeystoreFile(path: string, password: string): `0x${string}` {
  const filepath = resolveKeystorePath(path);
  const raw = readFileSync(filepath, "utf8");
  const keystore = JSON.parse(raw) as Keystore.Keystore;
  const key = Keystore.toKey(keystore, { password });
  const privateKey = Keystore.decrypt(keystore, key);
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("Keystore decrypted, but did not contain a valid EVM private key.");
  }
  return privateKey as `0x${string}`;
}

function loadGeneratedWalletRegistry(apowDir = getDefaultApowDir()): GeneratedWalletRegistry {
  try {
    const raw = readFileSync(getGeneratedWalletsPath(apowDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<GeneratedWalletRegistry>;
    if (parsed.version !== GENERATED_WALLETS_VERSION || !Array.isArray(parsed.wallets)) {
      return { version: GENERATED_WALLETS_VERSION, wallets: [] };
    }
    return {
      version: GENERATED_WALLETS_VERSION,
      wallets: parsed.wallets.filter((wallet): wallet is GeneratedWalletRecord => (
        typeof wallet === "object"
        && wallet !== null
        && typeof wallet.address === "string"
        && typeof wallet.keystorePath === "string"
        && typeof wallet.createdAt === "string"
      )),
    };
  } catch {
    return { version: GENERATED_WALLETS_VERSION, wallets: [] };
  }
}
