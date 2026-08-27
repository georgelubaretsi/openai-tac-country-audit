import assert from "node:assert/strict";
import { access, lstat, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertInside, atomicWrite, prepareRuntime, sha256 } from "../lib/runtime.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("runtime custody is ignored, private, and atomic", async () => {
  const directory = resolve(repoRoot, "runtime/test-custody");
  const path = resolve(directory, "artifact.bin");
  await rm(directory, { recursive: true, force: true });
  try {
    await prepareRuntime(repoRoot, directory);
    const result = await atomicWrite(path, Buffer.from("synthetic fixture"));
    assert.equal(result.sha256, sha256(Buffer.from("synthetic fixture")));
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    await assert.rejects(access(`${path}.partial-${process.pid}`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime custody rejects paths outside runtime", () => {
  assert.throws(() => assertInside(resolve(repoRoot, "runtime"), resolve(repoRoot, "evidence/raw")));
});
