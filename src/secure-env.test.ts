import assert from "node:assert/strict";
import test from "node:test";

import { childEnv, claudeSubscriptionEnv, codexSubscriptionEnv } from "./secure-env";

const base = {
  PATH: "/bin",
  HOME: "/tmp/example-home",
  LANG: "en_US.UTF-8",
  PRIVATE_KEY: "wallet-secret",
  KEYSTORE_PASSWORD: "wallet-password",
  OPENAI_API_KEY: "api-billing-key",
  ANTHROPIC_API_KEY: "api-billing-key",
  ANTHROPIC_AUTH_TOKEN: "gateway-token",
  UNRELATED_SERVICE_TOKEN: "unrelated-secret",
};

test("general child environment removes wallet signing secrets", () => {
  const env = childEnv(base);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.OPENAI_API_KEY, "api-billing-key");
  assert.equal(env.PRIVATE_KEY, undefined);
  assert.equal(env.KEYSTORE_PASSWORD, undefined);
});

test("subscription CLI environments use a strict non-secret allowlist", () => {
  for (const env of [claudeSubscriptionEnv(base), codexSubscriptionEnv(base)]) {
    assert.equal(env.PATH, "/bin");
    assert.equal(env.HOME, "/tmp/example-home");
    assert.equal(env.LANG, "en_US.UTF-8");
    assert.equal(env.PRIVATE_KEY, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.UNRELATED_SERVICE_TOKEN, undefined);
  }
});
