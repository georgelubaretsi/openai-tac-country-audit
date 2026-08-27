#!/usr/bin/env node

import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicJson, atomicWrite, sha256 } from "../lib/runtime.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const runId = process.argv[2];
const screenshotsConfirmed = process.argv[3] === "--confirm-screenshots-pii-free";
if (process.argv.length !== 4 || !RUN_ID.test(runId ?? "") || !screenshotsConfirmed) {
  throw new Error("usage: node scripts/promote-evidence.mjs <run-id> --confirm-screenshots-pii-free");
}

const rawRoot = resolve(repoRoot, "runtime", "raw", runId);
const stagingRoot = resolve(repoRoot, "runtime", "sanitized-staging", runId);
const evidenceRoot = resolve(repoRoot, "evidence");
const manifestPathFor = path => `evidence/${relative(evidenceRoot, path).split(sep).join("/")}`;

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function assertInside(parent, child) {
  const rel = relative(parent, child);
  if (!rel || rel.startsWith("..") || rel.startsWith(sep)) throw new Error("artifact path escapes custody root");
}

async function ensureCleanEvidence() {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("symlink forbidden under evidence");
      if (entry.isDirectory()) await walk(path);
      else files.push(path);
    }
  }
  await walk(evidenceRoot);
  if (files.length) throw new Error("evidence directory is not empty; refusing to overwrite evidence");
}

async function promoteFile(source, destination, kind, rawSha256) {
  assertInside(resolve(repoRoot, "runtime"), source);
  assertInside(evidenceRoot, destination);
  const stat = await lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("promotion source is not a regular file");
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.partial-${process.pid}`;
  await copyFile(source, temporary);
  await chmod(temporary, 0o644);
  await rename(temporary, destination);
  const bytes = await readFile(destination);
  return {
    path: manifestPathFor(destination),
    kind,
    bytes: bytes.length,
    sha256: sha256(bytes),
    ...(rawSha256 ? { raw_sha256: rawSha256 } : {}),
  };
}

async function writeJsonEvidence(path, value, kind) {
  await atomicJson(path, value);
  await chmod(path, 0o644);
  const bytes = await readFile(path);
  return { path: manifestPathFor(path), kind, bytes: bytes.length, sha256: sha256(bytes) };
}

async function writeTextEvidence(path, value, kind) {
  await atomicWrite(path, value);
  await chmod(path, 0o644);
  const bytes = await readFile(path);
  return { path: manifestPathFor(path), kind, bytes: bytes.length, sha256: sha256(bytes) };
}

await ensureCleanEvidence();
const [audit, rawManifest, sanitizedManifest, supportMap] = await Promise.all([
  readJson(resolve(stagingRoot, "audit-report.json")),
  readJson(resolve(rawRoot, "manifest.json")),
  readJson(resolve(stagingRoot, "manifest.json")),
  readJson(resolve(stagingRoot, "canonical-support-map.json")),
]);
if (audit.schema !== "openai-cyber-verification-country-support/audit-report/v1" || audit.run_id !== runId || audit.passed !== true) {
  throw new Error("sanitized run has no passing audit report");
}
if (rawManifest.status !== "completed" || rawManifest.range?.start !== 0 ||
    rawManifest.range?.end !== rawManifest.option_count - 1 ||
    rawManifest.transitions.length !== rawManifest.option_count ||
    rawManifest.transitions.length !== sanitizedManifest.transitions.length) {
  throw new Error("raw and sanitized transitions do not cover the complete selector");
}
if (supportMap.run_id !== runId || !Array.isArray(supportMap.country_codes) || !supportMap.countries) {
  throw new Error("canonical support map contract mismatch");
}

const files = [];
const results = [];
for (let offset = 0; offset < sanitizedManifest.transitions.length; offset += 1) {
  const raw = rawManifest.transitions[offset];
  const clean = sanitizedManifest.transitions[offset];
  if (raw.index !== clean.index || raw.code !== clean.code || raw.name !== clean.name) {
    throw new Error("raw and sanitized transition ordering mismatch");
  }
  const stem = `${String(raw.index + 1).padStart(4, "0")}-${raw.code}`;
  const roles = [
    [clean.request.meta_path, `sanitized-transitions/requests/${stem}.meta.json`, "sanitized-request-metadata"],
    [clean.request.body_path, `sanitized-transitions/requests/${stem}.body.bin`, "sanitized-request-body"],
    [clean.response.meta_path, `sanitized-transitions/responses/${stem}.meta.json`, "sanitized-response-metadata"],
    [clean.response.body_path, `sanitized-transitions/responses/${stem}.body.bin`, "sanitized-response-body"],
  ];
  for (const [stagingPath, destinationPath, kind] of roles) {
    const source = resolve(stagingRoot, stagingPath);
    assertInside(stagingRoot, source);
    const sidecarPath = `${source}.redactions.json`;
    const sidecar = await readJson(sidecarPath);
    files.push(await promoteFile(source, resolve(evidenceRoot, destinationPath), kind, sidecar.raw.sha256));
    files.push(await promoteFile(sidecarPath,
      resolve(evidenceRoot, `sanitized-transitions/redactions/${stem}-${kind}.json`),
      "redaction-manifest"));
  }
  const screenshots = [
    [raw.screenshots.selected_path, `screenshots/countries/${stem}-selected.webp`, "country-selected-screenshot"],
    [raw.screenshots.result_path, `screenshots/countries/${stem}-result.webp`, "country-result-screenshot"],
    [raw.screenshots.widget_selected_path, `screenshots/widgets/${stem}-widget-selected.webp`, "widget-selected-screenshot"],
    [raw.screenshots.widget_result_path, `screenshots/widgets/${stem}-widget-result.webp`, "widget-result-screenshot"],
    [raw.screenshots.comparison_path, `screenshots/comparisons/${stem}-widget-comparison.webp`, "widget-comparison-screenshot"],
  ];
  for (const [rawScreenshot, destinationPath, kind] of screenshots) {
    const source = resolve(repoRoot, rawScreenshot);
    const destination = resolve(evidenceRoot, destinationPath);
    const artifact = await promoteFile(source, destination, kind);
    artifact.raw_sha256 = artifact.sha256;
    files.push(artifact);
  }
  const canonical = supportMap.countries[raw.code];
  if (!canonical || canonical.name !== raw.name) throw new Error("canonical country row missing");
  results.push({
    index: raw.index + 1,
    code: raw.code,
    name: raw.name,
    supported: canonical.supported,
    idclasses: canonical.idclasses,
    http_status: clean.response.http_status,
  });
}

const supported = results.filter(result => result.supported).length;
const countryMap = {
  schema: "openai-cyber-verification-country-support/v1",
  run_id: runId,
  summary: {
    total: results.length,
    supported,
    unsupported: results.length - supported,
    unique_codes: new Set(results.map(result => result.code)).size,
    all_http_200: results.every(result => result.http_status === 200),
  },
  results,
};
files.push(await writeJsonEvidence(resolve(evidenceRoot, "country-support.json"), countryMap, "canonical-country-map"));

const csvCell = value => /[",\n]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value);
const csv = [
  "index,code,name,supported,idclasses,http_status",
  ...results.map(result => [result.index, result.code, csvCell(result.name), result.supported,
    csvCell(result.idclasses.map(idclass => idclass.class ?? idclass).join("|")), result.http_status].join(",")),
].join("\n") + "\n";
files.push(await writeTextEvidence(resolve(evidenceRoot, "country-support.csv"), csv, "canonical-country-map-csv"));

const captureMetadata = {
  schema: "openai-cyber-verification-country-support/capture-metadata/v1",
  run_id: runId,
  started_at: rawManifest.started_at,
  completed_at: rawManifest.completed_at,
  delays_ms: rawManifest.delays_ms,
  option_count: rawManifest.option_count,
  transition_count: rawManifest.transitions.length,
  screenshot_count: rawManifest.transitions.length * 5,
  sanitizer_version: sanitizedManifest.sanitizer_version,
  audit_report_sha256: sha256(await readFile(resolve(stagingRoot, "audit-report.json"))),
  raw_capture_committed: false,
  privacy: "Exact raw requests, responses, metadata, and unreviewed media remain only in ignored local storage.",
};
files.push(await writeJsonEvidence(resolve(evidenceRoot, "capture-metadata.json"), captureMetadata, "capture-metadata"));

files.sort((left, right) => left.path.localeCompare(right.path));
await writeJsonEvidence(resolve(evidenceRoot, "manifest.json"), {
  schema: "openai-cyber-verification-country-support/evidence-manifest/v1",
  files,
}, "evidence-manifest");
console.log(`Promoted ${results.length} sanitized transitions and ${results.length * 5} screenshots.`);
