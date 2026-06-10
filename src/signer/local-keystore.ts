import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { config } from "../config";
import { appendAudit } from "../policy/audit-log";
import { createGuardedAccount } from "./guarded-account";
import type { ApowSigner } from "./types";

let cachedKey: Hex | undefined;
let cachedSigner: ApowSigner | null = null;

export function resetSigner(): void {
  cachedKey = undefined;
  cachedSigner = null;
}

export function getSigner(): ApowSigner | null {
  if (!config.privateKey) return null;
  if (cachedSigner && cachedKey === config.privateKey) return cachedSigner;

  const rawKey = config.privateKey;
  const base = privateKeyToAccount(rawKey);
  const guarded = createGuardedAccount(base);
  cachedKey = rawKey;
  cachedSigner = {
    address: base.address,
    kind: config.walletSource === "keystore" ? "keystore" : "env-key",
    account: guarded,
    unsafeRawKeyFor(consumer) {
      appendAudit({
        address: base.address,
        kind: "raw-key-handout",
        target: consumer,
        verdict: "allow",
        policyRule: "raw-key-handout",
      });
      return rawKey;
    },
  };
  return cachedSigner;
}

