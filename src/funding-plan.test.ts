import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareFunding, type FundingDependencies } from "./funding-plan";

const requirements = { ethReserve: 3000n, usdcTarget: 200n };
function fixture(eth: bigint, usdc: bigint) {
  let balance = { eth, usdc }; let swaps = 0;
  const deps: FundingDependencies = {
    balances: async () => balance,
    quoteEth: async missing => missing * 2n,
    swapEth: async (input, output) => { swaps++; balance = { eth: balance.eth - input, usdc: balance.usdc + output }; },
  };
  return { deps, swaps: () => swaps };
}
test("ETH-only funding converts once and an approved resume is idempotent", async () => {
  const f = fixture(5000n, 0n);
  assert.equal((await prepareFunding(requirements, f.deps, true)).ready, true);
  assert.equal((await prepareFunding(requirements, f.deps, true)).ready, true);
  assert.equal(f.swaps(), 1);
});
test("deposit quote includes USDC cost and preserves the entire gas/mint reserve", async () => {
  const f = fixture(3100n, 0n);
  const plan = await prepareFunding(requirements, f.deps, true);
  assert.equal(plan.depositEth, 300n); assert.equal(plan.ready, false); assert.equal(f.swaps(), 0);
});
test("a quote-only request never signs a swap", async () => {
  const f = fixture(5000n, 0n);
  assert.equal((await prepareFunding(requirements, f.deps, false)).ready, false);
  assert.equal(f.swaps(), 0);
});
test("ETH-only advanced mode needs no price provider or USDC", async () => {
  const f = fixture(3000n, 0n);
  f.deps.quoteEth = async () => { throw new Error("must not quote"); };
  assert.equal((await prepareFunding({ ...requirements, usdcTarget: 0n }, f.deps, true)).ready, true);
});
test("failed or short-output swaps stop the flow before mint/mining", async () => {
  const f = fixture(5000n, 0n); f.deps.swapEth = async () => {};
  await assert.rejects(prepareFunding(requirements, f.deps, true), /did not meet/);
  f.deps.swapEth = async () => { throw new Error("policy denied"); };
  await assert.rejects(prepareFunding(requirements, f.deps, true), /policy denied/);
});
test("swap gas is included in the deposit, but does not consume the post-swap mint reserve", async () => {
  const f = fixture(3400n, 0n);
  assert.equal((await prepareFunding({ ...requirements, swapGasReserve: 50n }, f.deps, true)).depositEth, 50n);
  const g = fixture(3450n, 0n);
  g.deps.swapEth = async () => { g.deps.balances = async () => ({ eth: 3000n, usdc: 200n }); };
  assert.equal((await prepareFunding({ ...requirements, swapGasReserve: 50n }, g.deps, true)).ready, true);
});
test("live swap fees replace a smaller fixed allowance in the funding quote", async () => {
  const f = fixture(3400n, 0n);
  f.deps.quoteSwapGas = async () => 137n;
  assert.equal((await prepareFunding({ ...requirements, swapGasReserve: 50n }, f.deps, false)).depositEth, 137n);
});
test("a failed fee quote stops before any swap", async () => {
  const f = fixture(5000n, 0n);
  f.deps.quoteSwapGas = async () => { throw new Error("fee oracle unavailable"); };
  await assert.rejects(prepareFunding(requirements, f.deps, true), /fee oracle unavailable/);
  assert.equal(f.swaps(), 0);
});
