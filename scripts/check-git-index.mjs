#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_MANIFEST = "evidence/manifest.json";
const EVIDENCE_MANIFEST_SCHEMA = "openai-cyber-verification-country-support/evidence-manifest/v1";
const REPRESENTATIVE_VIDEO = "evidence/video/representative/unsupported-country-transitions.mp4";
const REPRESENTATIVE_VIDEO_ROOT = "evidence/video/representative/";
const RAW_CAPTURE_SCHEMA = "openai-cyber-verification-country-support/raw-capture/v1";
const MAX_JSON_BYTES = 4 * 1024 * 1024;

class PolicyError extends Error {}

function git(args, { encoding = "utf8" } = {}) {
  const result = spawnSync("git", ["-C", PROJECT_ROOT, ...args], {
    encoding,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new PolicyError("git-unavailable");
  if (result.status !== 0) throw new PolicyError("git-command-failed");
  return result;
}

function readIndex() {
  const output = git(["ls-files", "--cached", "--stage", "-z"], { encoding: "buffer" }).stdout;
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(output);
  const entries = [];
  for (const record of decoded.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const header = tab === -1 ? "" : record.slice(0, tab);
    const filePath = tab === -1 ? "" : record.slice(tab + 1);
    const match = /^(\d{6}) ([0-9a-f]{40,64}) ([0-3])$/.exec(header);
    if (!match || !filePath) throw new PolicyError("ambiguous-index-entry");
    entries.push({ mode: match[1], object: match[2], stage: Number(match[3]), path: filePath });
  }
  if (entries.some((entry) => entry.stage !== 0)) throw new PolicyError("unmerged-index");
  return entries;
}

function readIndexBlob(entry, maximumBytes) {
  const sizeOutput = git(["cat-file", "-s", entry.object]).stdout.trim();
  if (!/^(0|[1-9]\d*)$/.test(sizeOutput)) throw new PolicyError("ambiguous-object-size");
  const size = Number(sizeOutput);
  if (!Number.isSafeInteger(size) || size > maximumBytes) throw new PolicyError("oversized-object");
  const blob = git(["cat-file", "blob", entry.object], { encoding: "buffer" }).stdout;
  if (blob.length !== size) throw new PolicyError("incomplete-object-read");
  return blob;
}

function hasRawCapturePath(filePath) {
  const lower = filePath.toLowerCase();
  if (lower === "runtime" || lower.startsWith("runtime/")) return true;
  if (!lower.startsWith("evidence/")) return false;
  return /(^|\/)(raw|raw-capture|raw-captures|media-raw)(\/|$)/.test(lower)
    || /(^|[._-])raw([._-]|$)/.test(path.posix.basename(lower));
}

function inspectTrackedJson(entries, violations) {
  for (const entry of entries) {
    if (!entry.path.toLowerCase().endsWith(".json")) continue;
    let document;
    try {
      document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readIndexBlob(entry, MAX_JSON_BYTES)));
    } catch {
      if (entry.path.startsWith("evidence/")) violations.add("evidence-json-invalid");
      continue;
    }
    const stack = [document];
    let visited = 0;
    while (stack.length) {
      if (++visited > 250_000) {
        violations.add(entry.path.startsWith("evidence/") ? "evidence-json-ambiguous" : "tracked-json-ambiguous");
        break;
      }
      const value = stack.pop();
      if (value === RAW_CAPTURE_SCHEMA) {
        violations.add("raw-capture-format");
        break;
      }
      if (Array.isArray(value)) stack.push(...value);
      else if (value && typeof value === "object") stack.push(...Object.values(value));
    }
  }
}

function validateVideoManifest(entries, videos, violations) {
  if (videos.length === 0) return;
  const manifestEntry = entries.find((entry) => entry.path === EVIDENCE_MANIFEST);
  if (!manifestEntry || manifestEntry.mode !== "100644") {
    violations.add("evidence-manifest-missing");
    return;
  }
  try {
    const manifest = JSON.parse(readIndexBlob(manifestEntry, MAX_JSON_BYTES).toString("utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
      || manifest.schema !== EVIDENCE_MANIFEST_SCHEMA || !Array.isArray(manifest.files)) {
      violations.add("evidence-manifest-invalid");
      return;
    }
    const declarations = manifest.files.filter((file) => file && typeof file === "object"
      && !Array.isArray(file) && file.path === REPRESENTATIVE_VIDEO);
    if (declarations.length !== 1 || typeof declarations[0].kind !== "string" || declarations[0].kind.length === 0
      || !Number.isSafeInteger(declarations[0].bytes) || declarations[0].bytes < 0
      || typeof declarations[0].sha256 !== "string" || !/^[0-9a-f]{64}$/.test(declarations[0].sha256)) {
      violations.add("representative-video-undeclared");
    }
  } catch {
    violations.add("evidence-manifest-invalid");
  }
}

function main() {
  const violations = new Set();
  const entries = readIndex();
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    violations.add("duplicate-index-path");
  }

  for (const entry of entries) {
    if (entry.path === "runtime" || entry.path.startsWith("runtime/")) violations.add("runtime-tracked");
    if (hasRawCapturePath(entry.path)) violations.add("raw-capture-path");
    if (/\.(?:har|mhtml)$/i.test(entry.path)) violations.add("raw-capture-format");
  }
  inspectTrackedJson(entries, violations);

  const videos = entries.filter((entry) => entry.path.toLowerCase().endsWith(".mp4"));
  if (videos.some((entry) => !entry.path.startsWith(REPRESENTATIVE_VIDEO_ROOT))) {
    violations.add("video-outside-representative-root");
  }
  if (videos.some((entry) => entry.path !== REPRESENTATIVE_VIDEO)) {
    violations.add("unexpected-representative-video");
  }
  if (videos.length > 1) violations.add("multiple-videos");
  if (videos.some((entry) => entry.mode !== "100644")) violations.add("video-not-regular-file");
  validateVideoManifest(entries, videos, violations);

  if (violations.size) {
    process.stderr.write(`Git-index policy failed (${violations.size}): ${[...violations].sort().join(", ")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("Git-index policy passed.\n");
}

try {
  main();
} catch (error) {
  const code = error instanceof PolicyError ? error.message : "unexpected-error";
  process.stderr.write(`Git-index policy could not complete: ${code}\n`);
  process.exitCode = 1;
}
