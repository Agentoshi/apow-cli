import assert from "node:assert/strict";
import { test } from "node:test";

import { createLpUnlockGate } from "./lp-gate";

test("lp gate stays locked while lpDeployed is false", async () => {
  let reads = 0;
  const gate = createLpUnlockGate(async () => {
    reads += 1;
    return false;
  }, 1000, () => 0);
  assert.equal(await gate(), false);
  assert.equal(reads, 1);
});

test("lp gate throttles re-checks to the interval while locked", async () => {
  let reads = 0;
  let clock = 0;
  const gate = createLpUnlockGate(async () => {
    reads += 1;
    return false;
  }, 1000, () => clock);
  await gate();
  clock = 500;
  assert.equal(await gate(), false);
  assert.equal(reads, 1, "no re-read inside the interval");
  clock = 1000;
  assert.equal(await gate(), false);
  assert.equal(reads, 2, "re-reads once the interval elapses");
});

test("lp gate is sticky once unlocked and stops reading", async () => {
  let reads = 0;
  let deployed = false;
  let clock = 0;
  const gate = createLpUnlockGate(async () => {
    reads += 1;
    return deployed;
  }, 1000, () => clock);
  assert.equal(await gate(), false);
  deployed = true;
  clock = 1000;
  assert.equal(await gate(), true);
  clock = 10_000;
  assert.equal(await gate(), true);
  assert.equal(reads, 2, "no further reads after unlock");
});

test("lp gate treats reader errors as still locked", async () => {
  let clock = 0;
  let fail = true;
  const gate = createLpUnlockGate(async () => {
    if (fail) throw new Error("rpc down");
    return true;
  }, 1000, () => clock);
  assert.equal(await gate(), false);
  fail = false;
  clock = 1000;
  assert.equal(await gate(), true, "recovers on the next interval");
});
