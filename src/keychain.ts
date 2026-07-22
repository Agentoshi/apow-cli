// macOS Keychain integration for keystore passwords.
//
// Goal: the CLI never asks you to type a keystore password (that pattern feels
// like credential phishing). Instead, on wallet creation we generate a strong
// random password, hand it to the OS Keychain, and encrypt the keystore with
// it. At unlock time the CLI runs the `find-generic-password` command (wired as
// KEYSTORE_PASSWORD_CMD) and macOS itself shows a trusted authorization dialog —
// apow only receives the password the system chooses to release.
//
// The item is stored with an empty trusted-application list (`-T ""`), so every
// secret read requires user authorization (the visible system prompt), once per
// process. Non-macOS hosts report unavailable and the caller falls back to the
// interactive typed-password flow.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";

const SECURITY_BIN = "/usr/bin/security";
const KEYCHAIN_SERVICE = "apow-keystore";

export function isKeychainAvailable(): boolean {
  return process.platform === "darwin" && existsSync(SECURITY_BIN);
}

function defaultKeychainPath(): string | null {
  const result = spawnSync(SECURITY_BIN, ["default-keychain"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const match = result.stdout.match(/"([^"]+)"/);
  return match ? match[1] : null;
}

// Stricter check used before we actually write: confirm a default login keychain
// exists on disk. This is what prevents the alarming "a keychain cannot be found"
// dialog when the environment is unusual (e.g. an isolated HOME or no GUI login).
// If anything looks off we report unusable and the caller falls back cleanly.
export function isKeychainUsable(): boolean {
  if (!isKeychainAvailable()) return false;
  const path = defaultKeychainPath();
  return !!path && existsSync(path);
}

function keychainAccount(address: string): string {
  return address.toLowerCase();
}

// Wired into .env as KEYSTORE_PASSWORD_CMD; `-w` prints only the password to
// stdout, which the unlock path (config.ts resolveKeystorePassword) captures.
export function keychainPasswordCommand(address: string): string {
  return `${SECURITY_BIN} find-generic-password -s ${KEYCHAIN_SERVICE} -a ${keychainAccount(address)} -w`;
}

export function generateKeystorePassword(): string {
  // 256 bits, hex so there are no shell/argv-quoting edge cases anywhere.
  return randomBytes(32).toString("hex");
}

export function storeKeystorePasswordInKeychain(address: string, password: string): void {
  const account = keychainAccount(address);
  const label = `APoW mining keystore ${address.slice(0, 6)}…${address.slice(-4)}`;
  // Note: `-w <password>` puts the (random) password in argv for the duration of
  // this single call. That is an accepted tradeoff: the value is random, the
  // window is milliseconds, and the machine is single-user. `security` exposes
  // no stdin path for the password.
  const result = spawnSync(SECURITY_BIN, [
    "add-generic-password",
    "-U",                 // update in place if the item already exists
    "-s", KEYCHAIN_SERVICE,
    "-a", account,
    "-l", label,
    "-w", password,
    "-T", "",            // empty trusted-app list => macOS prompts on every secret read
  ], { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || `exit ${result.status}`;
    throw new Error(`Failed to store keystore password in macOS Keychain: ${detail}`);
  }
}

export function deleteKeystorePasswordFromKeychain(address: string): void {
  spawnSync(SECURITY_BIN, [
    "delete-generic-password",
    "-s", KEYCHAIN_SERVICE,
    "-a", keychainAccount(address),
  ], { stdio: "ignore" });
}
