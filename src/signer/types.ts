import type { Address, Hex } from "viem";
import type { LocalAccount } from "viem/accounts";

export interface ApowSigner {
  readonly address: Address;
  readonly kind: "keystore" | "env-key";
  readonly account: LocalAccount;
  unsafeRawKeyFor(consumer: "clawrouter"): Hex;
}

