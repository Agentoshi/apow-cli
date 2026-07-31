import { mkdtempSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";

import {
  getGeneratedWalletsPath,
  loadEncryptedKeystoreFile,
  loadGeneratedWalletAddresses,
  loadGeneratedWallets,
  registerGeneratedWallet,
  saveEncryptedKeystoreFile,
} from "./wallet-store";

test("encrypted keystore round-trips with private file permissions", async () => {
  const home = mkdtempSync(join(tmpdir(), "apow-wallet-store-"));
  const apowDir = join(home, ".apow");
  try {
    const privateKey = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
    const account = privateKeyToAccount(privateKey);
    const path = await saveEncryptedKeystoreFile(account.address, privateKey, "test-password", apowDir);
    assert.equal(loadEncryptedKeystoreFile(path, "test-password"), privateKey);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(home, ".apow", "keystores")).mode & 0o777, 0o700);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("generated-wallet registry includes only locally generated wallets with their APoW keystore", async () => {
  const home = mkdtempSync(join(tmpdir(), "apow-generated-wallets-"));
  const apowDir = join(home, ".apow");
  try {
    const generatedKey = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
    const secondGeneratedKey = "0x3333333333333333333333333333333333333333333333333333333333333333" as const;
    const importedKey = "0x2222222222222222222222222222222222222222222222222222222222222222" as const;
    const generatedAccount = privateKeyToAccount(generatedKey);
    const secondGeneratedAccount = privateKeyToAccount(secondGeneratedKey);
    const importedAccount = privateKeyToAccount(importedKey);
    const generatedPath = await saveEncryptedKeystoreFile(
      generatedAccount.address,
      generatedKey,
      "test-password",
      apowDir,
    );
    const secondGeneratedPath = await saveEncryptedKeystoreFile(
      secondGeneratedAccount.address,
      secondGeneratedKey,
      "second-test-password",
      apowDir,
    );
    await saveEncryptedKeystoreFile(importedAccount.address, importedKey, "test-password", apowDir);

    registerGeneratedWallet(generatedAccount.address, generatedPath, apowDir);
    registerGeneratedWallet(secondGeneratedAccount.address, secondGeneratedPath, apowDir);

    assert.deepEqual(
      loadGeneratedWalletAddresses(apowDir),
      [generatedAccount.address, secondGeneratedAccount.address],
    );
    assert.deepEqual(
      loadGeneratedWallets(apowDir).map(({ address, keystorePath }) => ({ address, keystorePath })),
      [
        { address: generatedAccount.address, keystorePath: generatedPath },
        { address: secondGeneratedAccount.address, keystorePath: secondGeneratedPath },
      ],
    );
    assert.equal(statSync(getGeneratedWalletsPath(apowDir)).mode & 0o777, 0o600);

    unlinkSync(generatedPath);
    assert.deepEqual(loadGeneratedWalletAddresses(apowDir), [secondGeneratedAccount.address]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
