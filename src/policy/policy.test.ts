import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { concatHex, numberToHex, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { config } from "../config";
import { createGuardedAccount } from "../signer/guarded-account";
import { SELECTORS, USDC_ADDRESS, padAddress } from "./decode";
import {
  evaluateTx,
  evaluateTypedData,
  loadPolicy,
  savePolicy,
  validateEasyModePolicyCaps,
  writeDefaultPolicyFile,
} from "./policy";

async function withPolicyTemp<T>(fn: () => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "apow-policy-"));
  const oldPolicyPath = process.env.APOW_POLICY_PATH;
  const oldDataDir = process.env.APOW_DATA_DIR;
  process.env.APOW_POLICY_PATH = join(dir, "policy.json");
  process.env.APOW_DATA_DIR = join(dir, ".apow");
  try {
    writeDefaultPolicyFile(true);
    return await fn();
  } finally {
    if (oldPolicyPath === undefined) delete process.env.APOW_POLICY_PATH;
    else process.env.APOW_POLICY_PATH = oldPolicyPath;
    if (oldDataDir === undefined) delete process.env.APOW_DATA_DIR;
    else process.env.APOW_DATA_DIR = oldDataDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("policy allows ERC-8021-suffixed AGENT transfer only to payout", async () => {
  await withPolicyTemp(() => {
    const payout = "0x1111111111111111111111111111111111111111";
    const policy = writeDefaultPolicyFile(true);
    assert.ok(policy.endsWith("policy.json"));
    const current = JSON.parse(readFileSync(policy, "utf8"));
    current.payout = payout;
    savePolicy(current);

    const data = concatHex([
      SELECTORS.transfer,
      padAddress(payout),
      numberToHex(123n, { size: 32 }),
      "0xdeadbeef",
    ]);
    const verdict = evaluateTx({
      account: payout,
      to: config.agentCoinAddress,
      value: 0n,
      data,
      context: "sweep",
    });
    assert.equal(verdict.verdict, "allow");
    assert.equal(verdict.rule, "agent-sweep-to-payout");
  });
});

test("policy denies Permit typed data and allows capped EIP-3009 x402", async () => {
  await withPolicyTemp(() => {
    const permit = evaluateTypedData({
      account: "0x1111111111111111111111111111111111111111",
      context: "mine",
      parameters: {
        domain: { verifyingContract: USDC_ADDRESS },
        primaryType: "Permit",
        message: {},
      },
    });
    assert.equal(permit.verdict, "deny");

    const payment = evaluateTypedData({
      account: "0x1111111111111111111111111111111111111111",
      context: "mine",
      parameters: eip3009TypedData("0x2222222222222222222222222222222222222222", parseUnits("0.301", 6)),
    });
    assert.equal(payment.verdict, "allow");
    assert.equal(payment.kind, "x402");
  });
});

test("guarded account signs allowed EIP-3009 typed data identically to base account", async () => {
  await withPolicyTemp(async () => {
    const base = privateKeyToAccount("0x1111111111111111111111111111111111111111111111111111111111111111");
    const guarded = createGuardedAccount(base);
    const typedData = eip3009TypedData("0x2222222222222222222222222222222222222222", parseUnits("0.301", 6));
    assert.equal(await guarded.signTypedData(typedData), await base.signTypedData(typedData));
  });
});

test("Easy Mode policy validation accepts defaults and rejects relaxed spend caps", async () => {
  await withPolicyTemp(() => {
    writeDefaultPolicyFile(true);
    const policy = loadPolicy();
    assert.equal(validateEasyModePolicyCaps(policy), null);

    policy.maxMintEth = "0.02";
    assert.match(validateEasyModePolicyCaps(policy) ?? "", /must not exceed 0\.01 ETH/);

    policy.maxMintEth = "0.01";
    policy.x402.dailyUsdc = 21;
    assert.match(validateEasyModePolicyCaps(policy) ?? "", /between 0 and 20 USDC/);
  });
});

function eip3009TypedData(payee: `0x${string}`, value: bigint) {
  return {
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: USDC_ADDRESS,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: "0x1111111111111111111111111111111111111111",
      to: payee,
      value,
      validAfter: 0n,
      validBefore: 9999999999n,
      nonce: "0x0000000000000000000000000000000000000000000000000000000000000000",
    },
  } as const;
}
