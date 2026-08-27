import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, rename } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const runId = () => new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
export const sleep = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));

export function assertInside(parent, candidate) {
  const rel = relative(resolve(parent), resolve(candidate));
  if (rel === "" || rel === "runtime") return;
  if (rel.startsWith("..") || rel.startsWith(sep)) {
    throw new Error(`path must stay inside ${parent}`);
  }
}

async function assertNoSymlink(path, stopAt) {
  const resolvedStop = resolve(stopAt);
  let current = resolve(path);
  while (current.startsWith(resolvedStop) && current !== resolvedStop) {
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`symlink is forbidden in runtime custody path: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    current = dirname(current);
  }
}

export async function prepareRuntime(repoRoot, path) {
  const runtimeRoot = resolve(repoRoot, "runtime");
  assertInside(runtimeRoot, path);
  await assertNoSymlink(path, repoRoot);
  try {
    await execFileAsync("git", ["check-ignore", "-q", "runtime/"], { cwd: repoRoot });
  } catch {
    throw new Error("runtime/ is not ignored by Git; refusing to write sensitive capture data");
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(runtimeRoot, 0o700);
  await chmod(path, 0o700);
  return resolve(path);
}

export async function atomicWrite(path, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const temporary = `${path}.partial-${process.pid}`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

export async function atomicJson(path, value) {
  return atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}
