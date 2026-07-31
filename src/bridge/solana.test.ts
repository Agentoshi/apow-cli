import assert from "node:assert/strict";
import test from "node:test";
import { getAddressBalance } from "./solana";

test("Solana balance lookup uses JSON-RPC without the vulnerable web3 dependency", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        result: { context: { slot: 1 }, value: 1_230_000_000 },
        id: 1,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  try {
    assert.equal(
      await getAddressBalance("11111111111111111111111111111111"),
      1.23,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Solana RPC errors fail closed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32602, message: "Invalid param" },
        id: 1,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  try {
    await assert.rejects(
      getAddressBalance("invalid"),
      /Solana RPC getBalance failed: Invalid param/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
