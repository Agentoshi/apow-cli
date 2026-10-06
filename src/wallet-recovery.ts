import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";

/** Verify an independent unlock without returning a key or password to the caller. */
export function verifyWalletRecovery(keystorePath: string, expectedAddress: string, password?: string): void {
  const environment = { ...process.env };
  delete environment.PRIVATE_KEY;
  delete environment.KEYSTORE_PASSWORD;
  delete environment.APOW_KEYSTORE_PASSWORD;
  delete environment.KEYSTORE_PASSWORD_CMD;
  delete environment.APOW_KEYSTORE_PASSWORD_CMD;
  if (!password) {
    let saved: Record<string, string> = {};
    try { saved = parse(readFileSync(join(process.cwd(), ".env"))); } catch { /* report below */ }
    const command = saved.KEYSTORE_PASSWORD_CMD || saved.APOW_KEYSTORE_PASSWORD_CMD;
    if (!command?.trim()) {
      throw new Error("Before funding, save a secret-manager unlock command as KEYSTORE_PASSWORD_CMD in .env. A process-only password will not survive a restart. Do not put the password in chat or .env.");
    }
    environment.KEYSTORE_PASSWORD_CMD = command;
  }
  const script = `
    try {
      const fs = require('node:fs');
      const { spawnSync } = require('node:child_process');
      let password = fs.readFileSync(0, 'utf8');
      if (!password) {
        const result = spawnSync(process.env.KEYSTORE_PASSWORD_CMD, { shell: true, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
        if (result.status !== 0) process.exit(1);
        password = result.stdout.trim();
      }
      if (!password) process.exit(1);
      const { loadEncryptedKeystoreFile } = require(process.argv[1]);
      const { privateKeyToAccount } = require(process.argv[3]);
      const address = privateKeyToAccount(loadEncryptedKeystoreFile(process.argv[2], password)).address;
      process.stdout.write(address);
    } catch { process.exit(1); }
  `;
  const result = spawnSync(process.execPath, ["-e", script, join(__dirname, "wallet-store.js"), keystorePath, require.resolve("viem/accounts")], {
    env: environment, input: password ?? "", encoding: "utf8", timeout: 30_000,
    stdio: ["pipe", "pipe", "ignore"],
  });
  if (result.status !== 0 || result.stdout.trim().toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error("Fresh-process wallet recovery failed. Keep the same wallet and repair its secret-manager unlock before funding.");
  }
}
