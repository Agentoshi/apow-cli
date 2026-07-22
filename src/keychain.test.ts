import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  deleteKeystorePasswordFromKeychain,
  generateKeystorePassword,
  isKeychainAvailable,
  keychainPasswordCommand,
  storeKeystorePasswordInKeychain,
} from "./keychain";

test("generateKeystorePassword returns 64 hex chars (256 bits)", () => {
  const a = generateKeystorePassword();
  const b = generateKeystorePassword();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b, "passwords must be random");
});

test("keychainPasswordCommand is a -w find scoped to the lowercased address", () => {
  const cmd = keychainPasswordCommand("0xAbC0000000000000000000000000000000000123");
  assert.ok(cmd.includes("find-generic-password"));
  assert.ok(cmd.includes("-s apow-keystore"));
  assert.ok(cmd.includes("-a 0xabc0000000000000000000000000000000000123"));
  assert.ok(cmd.trim().endsWith("-w"), "must print only the password");
});

test("isKeychainAvailable is false off-darwin, true on darwin", () => {
  assert.equal(isKeychainAvailable(), process.platform === "darwin");
});

// Round-trip the store/delete path on macOS. Opt-in only (APOW_TEST_KEYCHAIN=1)
// so a plain `npm test` never writes to the user's login keychain. Deliberately
// never reads the secret (`-w`), so no authorization dialog is triggered.
test("store then delete works on macOS without reading the secret", {
  skip: process.platform !== "darwin" || process.env.APOW_TEST_KEYCHAIN !== "1",
}, () => {
  const addr = "0xteST0000000000000000000000000000000000ff";
  storeKeystorePasswordInKeychain(addr, generateKeystorePassword());
  const attrs = spawnSync("/usr/bin/security", ["find-generic-password", "-s", "apow-keystore", "-a", addr.toLowerCase()], { encoding: "utf8" });
  assert.equal(attrs.status, 0, "item should exist after store");
  deleteKeystorePasswordFromKeychain(addr);
  const after = spawnSync("/usr/bin/security", ["find-generic-password", "-s", "apow-keystore", "-a", addr.toLowerCase()], { encoding: "utf8" });
  assert.notEqual(after.status, 0, "item should be gone after delete");
});
