import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { findSourceDir } from "./build";

test("npm package includes every native grinder source used by build-grinders", () => {
  const sourceDir = findSourceDir();
  assert.ok(sourceDir, "local/gpu grinder sources are missing");

  for (const filename of [
    "grinder-cpu.c",
    "grinder-cuda.cu",
    "grinder.m",
    "keccak.metal",
    "Makefile",
  ]) {
    assert.ok(existsSync(join(sourceDir, filename)), `${filename} is missing`);
  }
});
