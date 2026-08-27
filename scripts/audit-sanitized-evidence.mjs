#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { atomicJson, prepareRuntime } from "../lib/runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAGING = path.join(ROOT, "runtime", "sanitized-staging");
const EVIDENCE = path.join(ROOT, "evidence");
const SCHEMAS = {
  raw: "openai-cyber-verification-country-support/raw-capture/v1",
  sanitized: "openai-cyber-verification-country-support/sanitized-capture/v1",
  redactions: "openai-cyber-verification-country-support/redaction-manifest/v1",
  map: "openai-cyber-verification-country-support/canonical-support-map/v1",
  evidence: "openai-cyber-verification-country-support/evidence-manifest/v1",
  report: "openai-cyber-verification-country-support/audit-report/v1",
};
const HASH = /^[0-9a-f]{64}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COUNTRY = /^[A-Z]{2}$/;
const REPLACEMENT = Buffer.from("[REDACTED]");
const JSON_REPLACEMENT = Buffer.from("\"[REDACTED]\"");
const MAX_ARTIFACT = 256 * 1024 * 1024;
const MAX_TEXT = 16 * 1024 * 1024;

class Audit {
  constructor() {
    this.issues = new Map();
    this.checked = { transitions: 0, artifacts: 0, redactions: 0, evidence_files: 0 };
  }
  add(code) { this.issues.set(code, (this.issues.get(code) ?? 0) + 1); }
  report(runId) {
    return {
      schema: SCHEMAS.report,
      run_id: runId,
      passed: this.issues.size === 0,
      checked: this.checked,
      issues: [...this.issues].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => ({ code, count })),
    };
  }
}

const object = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const validHash = value => typeof value === "string" && HASH.test(value);
const validBytes = value => Number.isSafeInteger(value) && value >= 0;
const exactKeys = (value, keys) => object(value)
  && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

function safeRelative(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.includes("\0")
    && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value && value !== "."
    && !value.startsWith("../") && !value.includes("/../");
}

function resolveInside(root, relativePath) {
  if (!safeRelative(relativePath)) throw new Error("unsafe-path");
  const candidate = path.resolve(root, relativePath);
  if (!candidate.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("escaping-path");
  return candidate;
}

async function bytesAt(root, relativePath, limit = MAX_ARTIFACT) {
  const candidate = resolveInside(root, relativePath);
  const stat = await lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error("unsafe-file");
  const bytes = await readFile(candidate);
  if (bytes.length !== stat.size) throw new Error("short-read");
  return bytes;
}

async function jsonAt(root, relativePath) {
  const bytes = await bytesAt(root, relativePath, MAX_TEXT);
  return { bytes, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
}

function entropy(text) {
  const counts = new Map();
  for (const character of text) counts.set(character, (counts.get(character) ?? 0) + 1);
  let sum = 0;
  for (const count of counts.values()) {
    const probability = count / text.length;
    sum -= probability * Math.log2(probability);
  }
  return sum;
}

function sensitiveMatches(text) {
  const values = [];
  const patterns = [
    /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+\b/giu,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu,
    /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/gu,
    /\b(?:inq|inquiry|itmpl|tmpl|template|ver|verification|rep|rpt|report|act|acc|account|txn|transaction|case|sess|session|evt|event|req|request|usr|user|wfl|workflow|org|env|pers)_[A-Za-z0-9]{8,}\b/giu,
    /\b(?:bearer|basic)\s+[A-Za-z0-9+/=_-]{8,}\b/giu,
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) values.push(match[0]);
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>]+/giu)) {
    try {
      const url = new URL(match[0].replace(/[),.;]+$/, ""));
      const signed = /^(?:x-amz-(?:algorithm|credential|date|expires|security-token|signature|signedheaders)|signature|sig|signed|token|access_token|expires|policy|key-pair-id|api_key|key|code|auth|authorization|credential|device|email|reference|session|user|account|inquiry)$/iu;
      if ([...url.searchParams.keys()].some(key => signed.test(key))) values.push(match[0]);
    } catch { values.push(match[0]); }
  }
  return values;
}

function scanText(text, audit, prefix) {
  if (text.includes(SCHEMAS.raw)
    || /(?:^|["'\s])(?:\.\.\/)*runtime\/[^\s"']*/u.test(text)) {
    audit.add(`${prefix}-raw-runtime-reference`);
  }
  if (sensitiveMatches(text).length) audit.add(`${prefix}-sensitive-pattern`);
}

function compileKnownMatcher(patterns) {
  const root = { next: new Map(), fail: null, terminal: false };
  root.fail = root;
  const seen = new Set();
  for (const pattern of patterns) {
    if (!pattern?.length) continue;
    const key = pattern.toString("base64");
    if (seen.has(key)) continue;
    seen.add(key);
    let node = root;
    for (const byte of pattern) {
      if (!node.next.has(byte)) node.next.set(byte, { next: new Map(), fail: root, terminal: false });
      node = node.next.get(byte);
    }
    node.terminal = true;
  }
  const queue = [];
  for (const child of root.next.values()) queue.push(child);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const node = queue[cursor];
    for (const [byte, child] of node.next) {
      let failure = node.fail;
      while (failure !== root && !failure.next.has(byte)) failure = failure.fail;
      if (failure.next.has(byte) && failure.next.get(byte) !== child) failure = failure.next.get(byte);
      child.fail = failure;
      child.terminal ||= failure.terminal;
      queue.push(child);
    }
  }
  return bytes => {
    let node = root;
    for (const byte of bytes) {
      while (node !== root && !node.next.has(byte)) node = node.fail;
      if (node.next.has(byte)) node = node.next.get(byte);
      if (node.terminal) return true;
    }
    return false;
  };
}

function metadataContentTypes(metadata) {
  const stack = [metadata];
  const found = new Set();
  let visited = 0;
  while (stack.length) {
    if (++visited > 100_000) throw new Error("metadata-too-deep");
    const value = stack.pop();
    if (Array.isArray(value)) stack.push(...value);
    else if (object(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (["content-type", "mimetype"].includes(key.toLowerCase()) && typeof child === "string") found.add(child.trim());
        else stack.push(child);
      }
    }
  }
  return [...found];
}

function parseMultipart(bytes, contentType) {
  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/iu.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.length > 200 || /[\r\n]/u.test(boundary)) throw new Error("bad-boundary");
  const delimiter = Buffer.from(`--${boundary}`);
  const crlf = Buffer.from("\r\n");
  const separator = Buffer.from("\r\n\r\n");
  if (!bytes.subarray(0, delimiter.length).equals(delimiter)) throw new Error("bad-prefix");
  let cursor = delimiter.length;
  let parts = 0;
  for (;;) {
    if (bytes.subarray(cursor, cursor + 2).equals(Buffer.from("--"))) {
      cursor += 2;
      if (cursor === bytes.length || (bytes.subarray(cursor, cursor + 2).equals(crlf) && cursor + 2 === bytes.length)) break;
      throw new Error("bad-trailer");
    }
    if (!bytes.subarray(cursor, cursor + 2).equals(crlf)) throw new Error("bad-delimiter");
    cursor += 2;
    const headerEnd = bytes.indexOf(separator, cursor);
    if (headerEnd < 0) throw new Error("bad-headers");
    const headers = bytes.subarray(cursor, headerEnd).toString("latin1").split("\r\n");
    if (!headers.length || headers.some(line => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:[\t\x20-\x7e]*$/u.test(line))) throw new Error("bad-header-line");
    const next = bytes.indexOf(Buffer.from(`\r\n--${boundary}`), headerEnd + separator.length);
    if (next < 0) throw new Error("missing-close");
    cursor = next + 2 + delimiter.length;
    parts += 1;
  }
  if (!parts) throw new Error("empty-multipart");
}

function parseBody(bytes, metadata, audit) {
  let types;
  try { types = metadataContentTypes(metadata); } catch { audit.add("metadata-content-type-ambiguous"); return undefined; }
  const byMediaType = new Map();
  for (const type of types) {
    const mediaType = type.split(";", 1)[0].trim().toLowerCase();
    if (!byMediaType.has(mediaType)) byMediaType.set(mediaType, []);
    byMediaType.get(mediaType).push(type);
  }
  const jsonMedia = [...byMediaType.keys()].filter(type => type === "application/json" || type.endsWith("+json"));
  const multipartMedia = [...byMediaType.keys()].filter(type => type.startsWith("multipart/"));
  if (jsonMedia.length > 1 || multipartMedia.length > 1 || (jsonMedia.length && multipartMedia.length)) {
    audit.add("body-content-type-ambiguous"); return undefined;
  }
  if (jsonMedia.length || (!types.length && /^[\x20\t\r\n]*[\[{]/u.test(bytes.toString("latin1")))) {
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { audit.add("sanitized-json-invalid"); }
  } else if (multipartMedia.length) {
    const declarations = byMediaType.get(multipartMedia[0]);
    const boundaries = new Set(declarations.map(type => /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/iu.exec(type)?.slice(1).find(Boolean)));
    if (boundaries.size !== 1 || boundaries.has(undefined)) audit.add("body-content-type-ambiguous");
    else {
      try { parseMultipart(bytes, declarations[0]); } catch { audit.add("sanitized-multipart-invalid"); }
    }
  }
  return undefined;
}

function validateRanges(sidecar, rawLength, sanitizedLength, audit) {
  if (!Array.isArray(sidecar.changes)) { audit.add("redaction-changes-invalid"); return undefined; }
  let rawEnd = 0;
  let sanitizedEnd = 0;
  const ranges = [];
  for (let index = 0; index < sidecar.changes.length; index += 1) {
    const change = sidecar.changes[index];
    const raw = change?.raw_range;
    const sanitized = change?.sanitized_range;
    const valid = exactKeys(change, ["index", "raw_range", "sanitized_range", "replacement", "reason"])
      && exactKeys(raw, ["start", "end"]) && exactKeys(sanitized, ["start", "end"])
      && change.index === index
      && Number.isSafeInteger(raw.start) && Number.isSafeInteger(raw.end)
      && Number.isSafeInteger(sanitized.start) && Number.isSafeInteger(sanitized.end)
      && raw.start >= rawEnd && raw.end > raw.start && raw.end <= rawLength
      && sanitized.start >= sanitizedEnd && sanitized.end >= sanitized.start && sanitized.end <= sanitizedLength
      && change.replacement === "[REDACTED]" && typeof change.reason === "string" && change.reason.length > 0;
    if (!valid) { audit.add("redaction-range-invalid"); return undefined; }
    ranges.push({
      rawStart: raw.start,
      rawEnd: raw.end,
      sanitizedStart: sanitized.start,
      sanitizedEnd: sanitized.end,
      reason: change.reason,
    });
    rawEnd = raw.end;
    sanitizedEnd = sanitized.end;
  }
  return ranges;
}

function verifyCorrespondence(raw, sanitized, ranges, audit, known) {
  let rawCursor = 0;
  let sanitizedCursor = 0;
  for (const range of ranges) {
    if (!raw.subarray(rawCursor, range.rawStart).equals(sanitized.subarray(sanitizedCursor, range.sanitizedStart))) {
      audit.add("outside-redactions-mismatch");
    }
    const replacement = sanitized.subarray(range.sanitizedStart, range.sanitizedEnd);
    if (!replacement.equals(REPLACEMENT) && !replacement.equals(JSON_REPLACEMENT)) {
      audit.add("redaction-replacement-mismatch");
    }
    const removed = raw.subarray(range.rawStart, range.rawEnd);
    if (range.reason !== "sensitive-field" && removed.length >= 8 && removed.length <= 1024 * 1024) {
      known.push(Buffer.from(removed));
    }
    rawCursor = range.rawEnd;
    sanitizedCursor = range.sanitizedEnd;
  }
  if (!raw.subarray(rawCursor).equals(sanitized.subarray(sanitizedCursor))) {
    audit.add("outside-redactions-mismatch");
  }
}

async function auditArtifact(rawPath, sanitizedPath, runId, sanitizerVersion, stagingRoot, audit, known) {
  const rawPrefix = `runtime/raw/${runId}/`;
  const mediaPrefix = `runtime/media-raw/${runId}/`;
  if (!safeRelative(rawPath) || (!rawPath.startsWith(rawPrefix) && !rawPath.startsWith(mediaPrefix))
    || !safeRelative(sanitizedPath) || sanitizedPath.startsWith("runtime/") || sanitizedPath.endsWith(".redactions.json")) {
    audit.add("artifact-path-invalid"); return undefined;
  }
  let raw;
  let sanitized;
  let sidecar;
  try {
    [raw, sanitized, sidecar] = await Promise.all([
      bytesAt(ROOT, rawPath), bytesAt(stagingRoot, sanitizedPath), jsonAt(stagingRoot, `${sanitizedPath}.redactions.json`),
    ]);
  } catch { audit.add("artifact-unreadable"); return undefined; }
  const value = sidecar.value;
  const valid = exactKeys(value, ["schema", "sanitizer_version", "artifact", "raw", "sanitized", "changes"])
    && value.schema === SCHEMAS.redactions && value.sanitizer_version === sanitizerVersion
    && value.artifact === sanitizedPath
    && exactKeys(value.raw, ["bytes", "sha256"]) && exactKeys(value.sanitized, ["bytes", "sha256"])
    && validBytes(value.raw.bytes) && validHash(value.raw.sha256)
    && validBytes(value.sanitized.bytes) && validHash(value.sanitized.sha256);
  if (!valid) { audit.add("redaction-manifest-invalid"); return { raw, sanitized }; }
  if (value.raw.bytes !== raw.length || value.raw.sha256 !== hash(raw)) audit.add("raw-artifact-hash-mismatch");
  if (value.sanitized.bytes !== sanitized.length || value.sanitized.sha256 !== hash(sanitized)) audit.add("sanitized-artifact-hash-mismatch");
  const ranges = validateRanges(value, raw.length, sanitized.length, audit);
  if (ranges) { verifyCorrespondence(raw, sanitized, ranges, audit, known); audit.checked.redactions += ranges.length; }
  audit.checked.artifacts += 1;
  return { raw, sanitized };
}

function validateBodyReferences(rawReference, sanitizedReference, loaded, audit) {
  if (!object(rawReference) || !object(sanitizedReference)
    || !validBytes(rawReference.bytes) || !validHash(rawReference.sha256)
    || !validBytes(sanitizedReference.bytes) || !validHash(sanitizedReference.sha256)) {
    audit.add("transition-body-reference-invalid"); return;
  }
  if (!loaded) return;
  if (rawReference.bytes !== loaded.raw.length || rawReference.sha256 !== hash(loaded.raw)) audit.add("raw-transition-body-hash-mismatch");
  if (sanitizedReference.bytes !== loaded.sanitized.length || sanitizedReference.sha256 !== hash(loaded.sanitized)) audit.add("sanitized-transition-body-hash-mismatch");
}

async function inventory(root, relative = "") {
  const entries = await readdir(relative ? resolveInside(root, relative) : root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    const stat = await lstat(resolveInside(root, child));
    if (stat.isSymbolicLink()) throw new Error("symlink");
    if (stat.isDirectory()) files.push(...await inventory(root, child));
    else if (stat.isFile()) files.push(child);
    else throw new Error("special-file");
  }
  return files;
}

async function auditEvidence(audit, known) {
  let files;
  try { files = await inventory(EVIDENCE); } catch { audit.add("evidence-inventory-invalid"); return; }
  audit.checked.evidence_files = files.length;
  const containsKnown = compileKnownMatcher(known);
  const actual = new Map();
  for (const file of files) {
    if (/(?:^|\/)(?:runtime|raw|raw-capture|raw-captures|media-raw)(?:\/|$)/iu.test(file)) audit.add("evidence-raw-path");
    if (sensitiveMatches(file).length) audit.add("evidence-sensitive-path");
    let bytes;
    try { bytes = await bytesAt(EVIDENCE, file); } catch { audit.add("evidence-file-unreadable"); continue; }
    if (containsKnown(bytes)) audit.add("evidence-known-sensitive");
    actual.set(`evidence/${file}`, { bytes: bytes.length, sha256: hash(bytes) });
    if (!/\.(?:png|jpe?g|webp|mp4)$/iu.test(file)) {
      if (bytes.length > MAX_TEXT) { audit.add("evidence-text-oversized"); continue; }
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        scanText(text, audit, "evidence");
        if (file.toLowerCase().endsWith(".json")) JSON.parse(text);
      } catch { audit.add("evidence-text-invalid"); }
    }
  }
  if (!files.length) return;
  if (!actual.has("evidence/manifest.json")) { audit.add("evidence-manifest-missing"); return; }
  let manifest;
  try { manifest = (await jsonAt(EVIDENCE, "manifest.json")).value; }
  catch { audit.add("evidence-manifest-invalid"); return; }
  if (!exactKeys(manifest, ["schema", "files"]) || manifest.schema !== SCHEMAS.evidence || !Array.isArray(manifest.files)) {
    audit.add("evidence-manifest-invalid"); return;
  }
  const declared = new Set();
  for (const file of manifest.files) {
    const entryKeys = file?.raw_sha256 === undefined
      ? ["path", "kind", "bytes", "sha256"]
      : ["path", "kind", "bytes", "sha256", "raw_sha256"];
    if (!exactKeys(file, entryKeys) || !safeRelative(file.path) || !file.path.startsWith("evidence/")
      || typeof file.kind !== "string" || !file.kind || !validBytes(file.bytes) || !validHash(file.sha256)
      || (file.raw_sha256 !== undefined && !validHash(file.raw_sha256))) {
      audit.add("evidence-manifest-entry-invalid"); continue;
    }
    if (declared.has(file.path)) audit.add("evidence-manifest-duplicate");
    declared.add(file.path);
    const record = actual.get(file.path);
    if (!record || record.bytes !== file.bytes || record.sha256 !== file.sha256) audit.add("evidence-manifest-hash-mismatch");
  }
  const expected = new Set([...actual.keys()].filter(file => file !== "evidence/manifest.json"));
  if (declared.size !== expected.size || [...expected].some(file => !declared.has(file))) audit.add("evidence-manifest-incomplete");
}

function deriveSupport(response) {
  const idclasses = response?.data?.attributes?.["next-step"]?.config?.idclasses;
  return { supported: Array.isArray(idclasses) && idclasses.length > 0, idclasses: Array.isArray(idclasses) ? idclasses : [] };
}

async function auditRun(runId, stagingRoot, audit, allowPartial = false) {
  let rawFile;
  let sanitizedFile;
  let mapFile;
  try {
    [rawFile, sanitizedFile, mapFile] = await Promise.all([
      jsonAt(ROOT, `runtime/raw/${runId}/manifest.json`),
      jsonAt(stagingRoot, "manifest.json"),
      jsonAt(stagingRoot, "canonical-support-map.json"),
    ]);
  } catch {
    audit.add("capture-manifest-unreadable");
    return { known: [], expected: new Set(["audit-report.json"]) };
  }
  const raw = rawFile.value;
  const sanitized = sanitizedFile.value;
  const map = mapFile.value;
  const expected = new Set(["manifest.json", "canonical-support-map.json", "audit-report.json"]);
  const known = [];
  if (!object(raw) || raw.schema !== SCHEMAS.raw || raw.run_id !== runId || !Array.isArray(raw.transitions)) {
    audit.add("raw-manifest-invalid");
    return { known, expected };
  }
  if (!allowPartial && (raw.status !== "completed" || raw.range?.start !== 0 ||
      raw.range?.end !== raw.option_count - 1 || raw.transitions.length !== raw.option_count)) {
    audit.add("raw-capture-incomplete");
  }
  if (!exactKeys(sanitized, ["schema", "sanitizer_version", "run_id", "transitions"])
    || sanitized.schema !== SCHEMAS.sanitized || sanitized.run_id !== runId
    || typeof sanitized.sanitizer_version !== "string" || !sanitized.sanitizer_version || !Array.isArray(sanitized.transitions)) {
    audit.add("sanitized-manifest-invalid");
    return { known, expected };
  }
  if (!exactKeys(map, ["schema", "sanitizer_version", "run_id", "country_codes", "countries"])
    || map.schema !== SCHEMAS.map || map.run_id !== runId
    || map.sanitizer_version !== sanitized.sanitizer_version || !Array.isArray(map.country_codes) || !object(map.countries)) {
    audit.add("support-map-invalid");
  }
  if (raw.transitions.length !== sanitized.transitions.length) audit.add("transition-count-mismatch");
  const countries = new Map();
  const count = Math.min(raw.transitions.length, sanitized.transitions.length);
  for (let index = 0; index < count; index += 1) {
    const source = raw.transitions[index];
    const transition = sanitized.transitions[index];
    audit.checked.transitions += 1;
    if (!object(source)
      || !exactKeys(transition, ["index", "code", "name", "selected_at", "submitted_at", "result_at", "request", "response", "screenshots"])
      || !exactKeys(transition.request, ["meta_path", "body_path", "bytes", "sha256"])
      || !exactKeys(transition.response, ["meta_path", "body_path", "http_status", "bytes", "sha256"])
      || !exactKeys(transition.screenshots, ["selected_path", "result_path", "widget_selected_path", "widget_result_path", "comparison_path"])
      || source.index !== index || transition.index !== index
      || source.code !== transition.code || source.name !== transition.name || source.selected_at !== transition.selected_at
      || source.submitted_at !== transition.submitted_at || source.result_at !== transition.result_at
      || !object(source.request) || !object(source.response) || !object(source.screenshots)
      || source.response.http_status !== transition.response.http_status) {
      audit.add("transition-structure-mismatch"); continue;
    }
    if (!COUNTRY.test(transition.code) || typeof transition.name !== "string" || !transition.name) audit.add("transition-country-invalid");
    const roles = [
      [source.request.meta_path, transition.request.meta_path, "request-meta", true],
      [source.request.body_path, transition.request.body_path, "request-body", true],
      [source.response.meta_path, transition.response.meta_path, "response-meta", true],
      [source.response.body_path, transition.response.body_path, "response-body", true],
      [source.screenshots.selected_path, transition.screenshots.selected_path, "selected-screenshot", false],
      [source.screenshots.result_path, transition.screenshots.result_path, "result-screenshot", false],
      [source.screenshots.widget_selected_path, transition.screenshots.widget_selected_path, "widget-selected-screenshot", false],
      [source.screenshots.widget_result_path, transition.screenshots.widget_result_path, "widget-result-screenshot", false],
      [source.screenshots.comparison_path, transition.screenshots.comparison_path, "widget-comparison-screenshot", false],
    ];
    const loaded = new Map();
    for (const [rawPath, sanitizedPath, role, required] of roles) {
      if (sanitizedPath === null && !required) continue;
      if (typeof rawPath !== "string" || typeof sanitizedPath !== "string") { audit.add("artifact-path-missing"); continue; }
      if (expected.has(sanitizedPath) || expected.has(`${sanitizedPath}.redactions.json`)) { audit.add("artifact-path-duplicate"); continue; }
      expected.add(sanitizedPath);
      expected.add(`${sanitizedPath}.redactions.json`);
      loaded.set(role, await auditArtifact(rawPath, sanitizedPath, runId, sanitized.sanitizer_version, stagingRoot, audit, known));
    }
    validateBodyReferences(source.request, transition.request, loaded.get("request-body"), audit);
    validateBodyReferences(source.response, transition.response, loaded.get("response-body"), audit);
    let requestMeta;
    let responseMeta;
    for (const [role, assign] of [["request-meta", value => { requestMeta = value; }], ["response-meta", value => { responseMeta = value; }]]) {
      const artifact = loaded.get(role);
      if (!artifact) continue;
      try { assign(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(artifact.sanitized))); }
      catch { audit.add("sanitized-metadata-json-invalid"); }
    }
    const requestBody = loaded.get("request-body")?.sanitized;
    const responseBody = loaded.get("response-body")?.sanitized;
    if (requestBody && requestMeta) parseBody(requestBody, requestMeta, audit);
    const response = responseBody && responseMeta ? parseBody(responseBody, responseMeta, audit) : undefined;
    const support = deriveSupport(response);
    if (countries.has(transition.code)) audit.add("transition-country-duplicate");
    countries.set(transition.code, {
      name: transition.name, supported: support.supported, idclasses: support.idclasses,
      request_count: requestBody ? 1 : 0, response_count: responseBody ? 1 : 0,
    });
  }
  if (object(map) && Array.isArray(map.country_codes) && object(map.countries)) {
    const codes = [...countries.keys()];
    if (new Set(map.country_codes).size !== map.country_codes.length || map.country_codes.some(code => !COUNTRY.test(code))) audit.add("support-map-country-codes-invalid");
    if (map.country_codes.length !== codes.length || map.country_codes.some((code, index) => code !== codes[index])) audit.add("support-map-country-codes-mismatch");
    if (Object.keys(map.countries).length !== codes.length || codes.some(code => !Object.hasOwn(map.countries, code))) audit.add("support-map-countries-mismatch");
    for (const [code, canonical] of countries) {
      const value = map.countries[code];
      if (!object(value) || value.name !== canonical.name || value.supported !== canonical.supported
        || value.request_count !== canonical.request_count || value.response_count !== canonical.response_count
        || !Array.isArray(value.idclasses) || JSON.stringify(value.idclasses) !== JSON.stringify(canonical.idclasses)) audit.add("support-map-country-invalid");
    }
  }
  const containsKnown = compileKnownMatcher(known);
  for (const file of expected) {
    if (file === "audit-report.json") continue;
    try {
      const bytes = await bytesAt(stagingRoot, file);
      if (containsKnown(bytes)) audit.add("sanitized-known-sensitive");
      try { scanText(new TextDecoder("utf-8", { fatal: true }).decode(bytes), audit, "sanitized"); }
      catch { /* Binary artifacts are checked through correspondence. */ }
    } catch { audit.add("sanitized-artifact-unreadable"); }
  }
  return { known, expected };
}

async function main() {
  const allowPartial = process.argv[2] === "--allow-partial";
  const runId = process.argv[allowPartial ? 3 : 2];
  if (process.argv.length !== (allowPartial ? 4 : 3) || !RUN_ID.test(runId) || runId === "." || runId === "..") {
    process.stderr.write("Audit could not start: invalid-run-id\n");
    process.exitCode = 1;
    return;
  }
  const stagingRoot = await prepareRuntime(ROOT, path.join(STAGING, runId));
  const audit = new Audit();
  let outcome = { known: [], expected: new Set(["audit-report.json"]) };
  try {
    outcome = await auditRun(runId, stagingRoot, audit, allowPartial);
    try {
      const files = new Set(await inventory(stagingRoot));
      files.delete("audit-report.json");
      const expectedBeforeReport = new Set(outcome.expected);
      expectedBeforeReport.delete("audit-report.json");
      if (files.size !== expectedBeforeReport.size || [...files].some(file => !expectedBeforeReport.has(file))) {
        audit.add("sanitized-staging-inventory-mismatch");
      }
    } catch {
      audit.add("sanitized-staging-inventory-invalid");
    }
    await auditEvidence(audit, outcome.known);
  } catch {
    audit.add("audit-internal-failure");
  }
  const report = audit.report(runId);
  await atomicJson(path.join(stagingRoot, "audit-report.json"), report);
  if (!report.passed) {
    process.stderr.write(`Sanitized evidence audit failed (${report.issues.length} issue categories).\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Sanitized evidence audit passed.\n");
  }
}

try { await main(); }
catch { process.stderr.write("Audit could not complete: custody-failure\n"); process.exitCode = 1; }
