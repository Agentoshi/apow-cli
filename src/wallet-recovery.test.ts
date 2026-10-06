import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { saveEncryptedKeystoreFile } from "./wallet-store";
const { verifyWalletRecovery } = require("../dist/wallet-recovery.js") as typeof import("./wallet-recovery");

test("fresh-process recovery requires a durable helper, matches the same address, and hides unlock failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "apow-recovery-test-"));
  const previousCwd = process.cwd();
  const privateKey = generatePrivateKey();
  const wallet = privateKeyToAccount(privateKey);
  const password = randomBytes(32).toString("hex");
  try {
    const keystore = await saveEncryptedKeystoreFile(wallet.address, privateKey, password, dir);
    process.chdir(dir);
    assert.throws(() => verifyWalletRecovery(keystore, wallet.address), /process-only password/);
    assert.doesNotThrow(() => verifyWalletRecovery(keystore, wallet.address, password));
    const helper = join(dir, "unlock.cjs");
    writeFileSync(helper, `process.stdout.write(${JSON.stringify(password)})`, { mode: 0o600 });
    writeFileSync(join(dir, ".env"), `KEYSTORE_PASSWORD_CMD='${process.execPath} ${helper}'\n`, { mode: 0o600 });
    assert.doesNotThrow(() => verifyWalletRecovery(keystore, wallet.address));
    assert.throws(() => verifyWalletRecovery(keystore, "0x0000000000000000000000000000000000000001"), /recovery failed/);
    writeFileSync(helper, "process.stdout.write('wrong-password')");
    assert.throws(() => verifyWalletRecovery(keystore, wallet.address), /recovery failed/);
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
