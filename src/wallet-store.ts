import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Keystore } from "ox";

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
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
  return filepath;
}

export function detectWalletAddressFromFilename(filename: string): string | null {
  const match = filename.match(/^wallet-(0x[0-9a-fA-F]{40})(?:\.keystore)?\.(txt|json)$/);
  return match?.[1] ?? null;
}
