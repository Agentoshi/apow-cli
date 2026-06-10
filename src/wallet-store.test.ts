import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";

import { detectWalletAddressFromFilename, loadEncryptedKeystoreFile, saveEncryptedKeystoreFile } from "./wallet-store";

test("encrypted keystore round-trips with private file permissions", async () => {
  const home = mkdtempSync(join(tmpdir(), "apow-wallet-store-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const privateKey = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
    const account = privateKeyToAccount(privateKey);
    const path = await saveEncryptedKeystoreFile(account.address, privateKey, "test-password");
    assert.equal(loadEncryptedKeystoreFile(path, "test-password"), privateKey);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(home, ".apow", "keystores")).mode & 0o777, 0o700);
  } finally {
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("detectWalletAddressFromFilename accepts supported wallet filenames", () => {
  assert.equal(
    detectWalletAddressFromFilename("wallet-0x1111111111111111111111111111111111111111.txt"),
    "0x1111111111111111111111111111111111111111",
  );
  assert.equal(
    detectWalletAddressFromFilename("wallet-0x2222222222222222222222222222222222222222.keystore.json"),
    "0x2222222222222222222222222222222222222222",
  );
  assert.equal(detectWalletAddressFromFilename("not-a-wallet.txt"), null);
});

