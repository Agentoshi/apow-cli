import { test } from "node:test";
import assert from "node:assert/strict";
import { getDepositAddress, SQUID_ROUTES, pollBridgeStatus } from "./squid";

test("bridge funding rejects a short minimum before issuing a deposit address", async () => {
  const previousFetch = globalThis.fetch;
  const previousId = process.env.SQUID_INTEGRATOR_ID;
  let calls = 0;
  process.env.SQUID_INTEGRATOR_ID = "test-integrator";
  globalThis.fetch = async () => { calls++; return Response.json({ route: { estimate: { toAmountMin: "9" } } }); };
  try {
    await assert.rejects(getDepositAddress("0x0000000000000000000000000000000000000001", 1, SQUID_ROUTES.sol_to_eth, 10n), /does not guarantee enough/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousId === undefined) delete process.env.SQUID_INTEGRATOR_ID; else process.env.SQUID_INTEGRATOR_ID = previousId;
  }
});

test("Solana USDC routes to native Base ETH and terminal uppercase status is understood", async () => {
  const previousFetch = globalThis.fetch;
  const previousId = process.env.SQUID_INTEGRATOR_ID;
  process.env.SQUID_INTEGRATOR_ID = "test-integrator";
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    if (calls === 1) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.toChain, "8453");
      assert.equal(body.toToken, SQUID_ROUTES.sol_to_eth.toToken);
      assert.equal(body.fromAmount, "1000000");
      return Response.json({ requestId: "test-route", route: { estimate: { toAmountMin: "10", toAmount: "11" } } });
    }
    if (calls === 2) return Response.json({ depositAddress: "So11111111111111111111111111111111111111112", requestId: "test-route" });
    return Response.json({ squidTransactionStatus: "SUCCESS" });
  };
  try {
    const result = await getDepositAddress("0x0000000000000000000000000000000000000001", 1, SQUID_ROUTES.sol_usdc_to_base_eth, 10n);
    assert.equal(result.minimumReceive, "0.00000000000000001");
    assert.equal((await pollBridgeStatus(result.requestId)).status, "fulfilled");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousId === undefined) delete process.env.SQUID_INTEGRATOR_ID; else process.env.SQUID_INTEGRATOR_ID = previousId;
  }
});
