import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { Keystore } from "ox";

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

export function getKeystoreDir(): string {
  const dir = join(homedir(), ".apow", "keystores");
  ensureDir(dir);
  return dir;
}

export function getPlaintextWalletPath(address: string, cwd = process.cwd()): string {
  return join(cwd, `wallet-${address}.txt`);
}

export function getKeystoreWalletPath(address: string): string {
  return join(getKeystoreDir(), `wallet-${address}.json`);
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

export function savePlaintextImportFile(address: string, privateKey: string, cwd = process.cwd()): string {
  const filepath = getPlaintextWalletPath(address, cwd);
  const content = [
    `Address:     ${address}`,
    `Private Key: ${privateKey}`,
    "",
    `Generated:   ${new Date().toISOString()}`,
    "",
    "Import this key into MetaMask, Rabby, Phantom, or any EVM wallet.",
    "Keep this file safe — anyone with the private key controls your funds.",
    "",
  ].join("\n");
  writeFileSync(filepath, content, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(filepath, 0o600);
  } catch {
    // Best-effort permissions hardening.
  }
  return filepath;
}

export async function saveEncryptedKeystoreFile(
  address: `0x${string}`,
  privateKey: `0x${string}`,
  password: string,
): Promise<string> {
  const filepath = getKeystoreWalletPath(address);
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

export function detectWalletAddressFromFilename(filename: string): string | null {
  const match = filename.match(/^wallet-(0x[0-9a-fA-F]{40})(?:\.keystore)?\.(txt|json)$/);
  return match?.[1] ?? null;
}
