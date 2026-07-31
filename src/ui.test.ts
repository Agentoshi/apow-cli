import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { readMaskedInput } from "./ui";

test("masked secret input renders asterisks without exposing the value", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    rendered += chunk;
  });

  const resultPromise = readMaskedInput("  Keystore password: ", input, output);
  input.end("s3cret!\r");

  assert.equal(await resultPromise, "s3cret!");
  assert.equal(rendered, "  Keystore password: *******\n");
  assert.equal(rendered.includes("s3cret!"), false);
});
