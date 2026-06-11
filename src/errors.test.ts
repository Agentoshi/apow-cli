import assert from "node:assert/strict";
import { test } from "node:test";

import { errorText, redactUrls } from "./errors";

test("redactUrls strips keyed paths but keeps the host", () => {
  const input = "URL: https://multi-foo-bar.base-mainnet.quiknode.pro/780bb5d6952394c5c78c2a61e13cbe6f2c08d18c/ failed";
  assert.equal(redactUrls(input), "URL: https://multi-foo-bar.base-mainnet.quiknode.pro/… failed");
});

test("redactUrls handles multiple URLs and query strings", () => {
  const input = "a https://x.io/v2/key123?token=abc b http://y.dev/secret c";
  assert.equal(redactUrls(input), "a https://x.io/… b http://y.dev/… c");
});

test("redactUrls leaves text without URLs unchanged", () => {
  const input = "Policy denied: unknown-call-0x12345678";
  assert.equal(redactUrls(input), input);
});

test("errorText redacts viem-style multi-line error messages", () => {
  const err = new Error("HTTP request failed.\n\nStatus: 429\nURL: https://base-mainnet.example.com/abc123/\nDetails: over rate limit");
  const text = errorText(err);
  assert.ok(text.includes("https://base-mainnet.example.com/…"));
  assert.ok(!text.includes("abc123"));
});
