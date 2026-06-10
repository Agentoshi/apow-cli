import type { Hex } from "viem";
import type { LocalAccount } from "viem/accounts";

import { appendAudit } from "../policy/audit-log";
import { getSignerContext } from "../policy/context";
import { assertAllowed, evaluateTx, evaluateTypedData } from "../policy/policy";
import { recordSpend } from "../policy/spend-ledger";
import { calldataSelector } from "../policy/decode";

export function createGuardedAccount(base: LocalAccount): LocalAccount {
  return {
    ...base,
    async signTransaction(transaction, options) {
      const context = getSignerContext();
      const verdict = evaluateTx({
        account: base.address,
        to: transaction.to,
        value: transaction.value,
        data: transaction.data,
        context,
      });
      appendAudit({
        address: base.address,
        kind: verdict.kind,
        target: transaction.to ?? undefined,
        selector: calldataSelector(transaction.data as Hex | undefined),
        valueWei: transaction.value?.toString(),
        verdict: verdict.verdict,
        policyRule: verdict.rule,
        context,
      });
      assertAllowed(verdict);
      return base.signTransaction(transaction, options);
    },
    async signTypedData(parameters) {
      const context = getSignerContext();
      const verdict = evaluateTypedData({ account: base.address, parameters, context });
      appendAudit({
        address: base.address,
        kind: verdict.kind,
        target: "typed-data",
        usdc: verdict.usdc?.toString(),
        payee: verdict.payee,
        verdict: verdict.verdict,
        policyRule: verdict.rule,
        context,
      });
      assertAllowed(verdict);
      if (verdict.kind === "x402" && verdict.usdc !== undefined) {
        recordSpend({ address: base.address, kind: "x402", usdc: verdict.usdc, payee: verdict.payee });
      }
      return base.signTypedData(parameters);
    },
    async signMessage({ message }) {
      appendAudit({
        address: base.address,
        kind: "other",
        target: "signMessage",
        verdict: "deny",
        policyRule: "sign-message-denied",
        context: getSignerContext(),
      });
      throw new Error("Policy denied: sign-message-denied. APoW CLI does not sign arbitrary messages.");
    },
    sign: base.sign
      ? async ({ hash }) => {
          appendAudit({
            address: base.address,
            kind: "other",
            target: "raw-sign",
            verdict: "deny",
            policyRule: "raw-sign-denied",
            context: getSignerContext(),
          });
          throw new Error(`Policy denied: raw-sign-denied. Refusing to sign raw hash ${hash.slice(0, 10)}...`);
        }
      : undefined,
  };
}
