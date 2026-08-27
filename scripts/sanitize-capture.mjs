#!/usr/bin/env node

import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { replaceByteSpans, scanJsonTokens } from "../lib/json-spans.mjs";
import { assertInside, atomicJson, atomicWrite, prepareRuntime, sha256 } from "../lib/runtime.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(await readFile(resolve(repoRoot, "config/redaction-policy.json"), "utf8"));
const SANITIZER_VERSION = policy.sanitizer_version;
const REPLACEMENT = policy.replacement;
const REPLACEMENT_BYTES = Buffer.from(REPLACEMENT);
const JSON_REPLACEMENT_BYTES = Buffer.from(JSON.stringify(REPLACEMENT));
const utf8 = new TextDecoder("utf-8", { fatal: true });
const normalizedFragments = policy.sensitive_key_fragments.map(value => normalizeKey(value));
const sensitiveExactKeys = new Set(policy.sensitive_exact_keys.map(value => value.toLowerCase()));
const sensitiveUrlParameters = new Set(policy.sensitive_url_parameters.map(value => value.toLowerCase()));

function fail(message) {
  throw new Error(`sanitization refused: ${message}`);
}

function normalizeKey(value) {
  return String(value).toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function pathStrings(path) {
  return path.filter(part => typeof part === "string");
}

function pathHasSensitiveKey(path) {
  return pathStrings(path).some(part => {
    const lower = part.toLowerCase();
    const normalized = normalizeKey(part);
    return sensitiveExactKeys.has(lower) || normalizedFragments.some(fragment => normalized.includes(fragment));
  });
}

function isPreservedIdclassLeaf(path) {
  const normalized = pathStrings(path).map(normalizeKey);
  const last = normalized.at(-1);
  return normalized.includes("idclasses") && new Set(["id", "name", "label", "type", "code", "value", "country", "countrycode", "documenttype"]).has(last);
}

function isExplicitSafeLeaf(path) {
  const normalized = pathStrings(path).map(normalizeKey);
  const last = normalized.at(-1);
  if (["country", "countrycode", "countryname", "locale", "step", "nextstep"].includes(last)) return true;
  if (normalized.some(part => ["localization", "localisation", "translation", "translations"].includes(part))) return true;
  return isPreservedIdclassLeaf(path);
}

function shannonEntropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function isHighEntropyIdentifier(value) {
  const { minimum_length: minimumLength, minimum_shannon_bits_per_character: minimumEntropy } = policy.high_entropy;
  if (value.length < minimumLength || !/^[A-Za-z0-9_+=./-]+$/.test(value) || /\s/.test(value)) return false;
  if (/^[a-z]+(?:[./-][a-z]+)+$/i.test(value)) return false;
  return shannonEntropy(value) >= minimumEntropy;
}

function sensitiveUrlReason(value) {
  if (!/^https?:\/\//i.test(value)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return "malformed-url";
  }
  for (const key of url.searchParams.keys()) {
    if (sensitiveUrlParameters.has(key.toLowerCase()) || pathHasSensitiveKey([key])) return "sensitive-url-parameter";
  }
  if ([...url.pathname.split("/"), url.hash.slice(1)].some(segment => isHighEntropyIdentifier(segment))) return "sensitive-url-identifier";
  return null;
}

function valueReason(value, path = []) {
  if (value === "") return null;
  if (/\b(?:bearer|basic)\s+[A-Za-z0-9+/=_-]+/i.test(value)) return "authentication-credential";
  if (/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(value)) return "token";
  if (/\b[\w.!#$%&'*+/=?^`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(value)) return "email-address";
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(value) || /(?:^|[\s([])(?:[A-Fa-f0-9]{0,4}:){2,}[A-Fa-f0-9]{0,4}(?:$|[\s)\]])/.test(value)) return "ip-address";
  const digits = value.replaceAll(/\D/g, "");
  if (digits.length >= 7 && digits.length <= 15 && /^\+?[\d ().-]+$/.test(value)) return "phone-number";
  const urlReason = sensitiveUrlReason(value);
  if (urlReason) return urlReason;
  const last = pathStrings(path).at(-1)?.toLowerCase();
  if (isHighEntropyIdentifier(value) && !isPreservedIdclassLeaf(path)) return "high-entropy-identifier";
  if (pathHasSensitiveKey(path) && !isExplicitSafeLeaf(path)) return last === "postdata" ? "embedded-request-body" : "sensitive-field";
  return null;
}

function coalesceReplacements(replacements) {
  const ordered = [...replacements].sort((left, right) => left.start - right.start || right.end - left.end);
  const result = [];
  for (const candidate of ordered) {
    const previous = result.at(-1);
    if (!previous || candidate.start >= previous.end) result.push(candidate);
    else {
      previous.end = Math.max(previous.end, candidate.end);
      previous.reason = previous.reason === candidate.reason ? previous.reason : "multiple-sensitive-patterns";
    }
  }
  return result;
}

function sanitizeJson(bytes) {
  const { strings, scalars } = scanJsonTokens(bytes);
  const replacements = [];
  for (const token of strings) {
    if (token.isKey) continue;
    const reason = valueReason(token.value, token.path);
    if (reason) replacements.push({ start: token.start, end: token.end, bytes: JSON_REPLACEMENT_BYTES, label: REPLACEMENT, reason });
  }
  for (const token of scalars) {
    if (pathHasSensitiveKey(token.path)) replacements.push({ start: token.start, end: token.end, bytes: JSON_REPLACEMENT_BYTES, label: REPLACEMENT, reason: "sensitive-numeric-field" });
  }
  return replaceByteSpans(bytes, replacements);
}

function genericTextCandidates(bytes) {
  const text = bytes.toString("latin1");
  const candidates = [];
  const patterns = [
    [/[\w.!#$%&'*+/=?^`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "email-address"],
    [/(?:\d{1,3}\.){3}\d{1,3}/g, "ip-address"],
    [/\b(?:bearer|basic)\s+[A-Za-z0-9+/=_-]+/gi, "authentication-credential"],
    [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "token"],
    [/https?:\/\/[^\s"'<>]+/gi, "url"]
  ];
  for (const [pattern, defaultReason] of patterns) {
    for (const match of text.matchAll(pattern)) {
      const reason = defaultReason === "url" ? sensitiveUrlReason(match[0]) : defaultReason;
      if (reason) candidates.push({ start: match.index, end: match.index + match[0].length, bytes: REPLACEMENT_BYTES, label: REPLACEMENT, reason });
    }
  }
  for (const match of text.matchAll(/\b[A-Za-z0-9_+=./-]{20,}\b/g)) {
    if (isHighEntropyIdentifier(match[0])) candidates.push({ start: match.index, end: match.index + match[0].length, bytes: REPLACEMENT_BYTES, label: REPLACEMENT, reason: "high-entropy-identifier" });
  }
  return coalesceReplacements(candidates);
}

function multipartBoundary(contentType, bytes) {
  const match = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? "");
  if (match) return match[1] ?? match[2];
  const firstLineEnd = bytes.indexOf(0x0a);
  const firstLine = bytes.subarray(0, firstLineEnd === -1 ? Math.min(bytes.length, 202) : firstLineEnd).toString("latin1").replace(/\r$/, "");
  return firstLine.startsWith("--") && firstLine.length > 2 && firstLine.length <= 200 ? firstLine.slice(2) : null;
}

function multipartDelimiterPositions(bytes, boundary) {
  const marker = Buffer.from(`--${boundary}`, "latin1");
  const positions = [];
  let from = 0;
  while (from <= bytes.length - marker.length) {
    const position = bytes.indexOf(marker, from);
    if (position === -1) break;
    const atLineStart = position === 0 || bytes[position - 1] === 0x0a;
    const after = position + marker.length;
    const validEnd = bytes[after] === 0x0a || (bytes[after] === 0x0d && bytes[after + 1] === 0x0a) || (bytes[after] === 0x2d && bytes[after + 1] === 0x2d);
    if (atLineStart && validEnd) positions.push(position);
    from = position + marker.length;
  }
  return positions;
}

function sanitizeMultipart(bytes, contentType) {
  const boundary = multipartBoundary(contentType, bytes);
  if (!boundary || /[\r\n]/.test(boundary)) fail("multipart boundary is missing or invalid");
  const positions = multipartDelimiterPositions(bytes, boundary);
  if (positions.length < 2) fail("multipart body has no complete parts");
  const replacements = [];
  for (let index = 0; index < positions.length - 1; index += 1) {
    const position = positions[index];
    const markerEnd = position + Buffer.byteLength(`--${boundary}`, "latin1");
    if (bytes[markerEnd] === 0x2d && bytes[markerEnd + 1] === 0x2d) break;
    let headersStart;
    if (bytes[markerEnd] === 0x0d && bytes[markerEnd + 1] === 0x0a) headersStart = markerEnd + 2;
    else if (bytes[markerEnd] === 0x0a) headersStart = markerEnd + 1;
    else fail("multipart delimiter has invalid line ending");
    const nextPosition = positions[index + 1];
    let headerEnd = bytes.indexOf(Buffer.from("\r\n\r\n"), headersStart);
    let separatorLength = 4;
    const lfHeaderEnd = bytes.indexOf(Buffer.from("\n\n"), headersStart);
    if (headerEnd === -1 || (lfHeaderEnd !== -1 && lfHeaderEnd < headerEnd)) {
      headerEnd = lfHeaderEnd;
      separatorLength = 2;
    }
    if (headerEnd === -1 || headerEnd >= nextPosition) fail("multipart part has invalid headers");
    const headersText = bytes.subarray(headersStart, headerEnd).toString("latin1");
    const disposition = /(?:^|\r?\n)content-disposition:[^\r\n]*/i.exec(headersText)?.[0] ?? "";
    const fieldName = /(?:^|;)\s*name="([^"]*)"/i.exec(disposition)?.[1] ?? "";
    const filenameMatch = /filename\s*=\s*"([^"]*)"/i.exec(headersText);
    if (filenameMatch?.[1]) {
      const filenameOffset = filenameMatch.index + filenameMatch[0].indexOf(filenameMatch[1]);
      replacements.push({ start: headersStart + filenameOffset, end: headersStart + filenameOffset + filenameMatch[1].length, bytes: REPLACEMENT_BYTES, label: REPLACEMENT, reason: "multipart-filename" });
    }
    const extendedFilename = /filename\*\s*=\s*([^;\r\n]+)/i.exec(headersText);
    if (extendedFilename?.[1]) {
      const filenameOffset = extendedFilename.index + extendedFilename[0].indexOf(extendedFilename[1]);
      replacements.push({ start: headersStart + filenameOffset, end: headersStart + filenameOffset + extendedFilename[1].length, bytes: REPLACEMENT_BYTES, label: REPLACEMENT, reason: "multipart-filename" });
    }
    const valueStart = headerEnd + separatorLength;
    let valueEnd = nextPosition;
    if (valueEnd >= 2 && bytes[valueEnd - 2] === 0x0d && bytes[valueEnd - 1] === 0x0a) valueEnd -= 2;
    else if (valueEnd >= 1 && bytes[valueEnd - 1] === 0x0a) valueEnd -= 1;
    const valueBytes = bytes.subarray(valueStart, valueEnd);
    let valueText = null;
    try {
      valueText = utf8.decode(valueBytes);
    } catch {
      // Non-text multipart values are redacted below.
    }
    const reason = filenameMatch || extendedFilename ? "multipart-file"
      : pathHasSensitiveKey([fieldName]) ? "sensitive-multipart-field"
        : valueText === null ? "unknown-binary-multipart-field" : valueReason(valueText, [fieldName]);
    if (reason && valueEnd > valueStart) replacements.push({ start: valueStart, end: valueEnd, bytes: REPLACEMENT_BYTES, label: REPLACEMENT, reason });
  }
  return replaceByteSpans(bytes, coalesceReplacements(replacements));
}

function sanitizeUrlEncoded(bytes) {
  const text = bytes.toString("latin1");
  const replacements = [];
  let cursor = 0;
  for (const field of text.split("&")) {
    const equals = field.indexOf("=");
    const rawKey = equals === -1 ? field : field.slice(0, equals);
    const rawValue = equals === -1 ? "" : field.slice(equals + 1);
    let key;
    let value;
    try {
      key = decodeURIComponent(rawKey.replaceAll("+", " "));
      value = decodeURIComponent(rawValue.replaceAll("+", " "));
    } catch {
      fail("malformed URL-encoded request body");
    }
    const valueStart = cursor + (equals === -1 ? field.length : equals + 1);
    const reason = pathHasSensitiveKey([key]) ? "sensitive-form-field" : valueReason(value, [key]);
    if (reason && rawValue) replacements.push({ start: valueStart, end: valueStart + rawValue.length, bytes: REPLACEMENT_BYTES, label: REPLACEMENT, reason });
    cursor += field.length + 1;
  }
  return replaceByteSpans(bytes, replacements);
}

function looksLikeJson(bytes) {
  let index = 0;
  while ([0x20, 0x09, 0x0a, 0x0d].includes(bytes[index])) index += 1;
  return bytes[index] === 0x7b || bytes[index] === 0x5b;
}

function sanitizeBody(bytes, contentType) {
  const mediaType = (contentType ?? "").split(";", 1)[0].trim().toLowerCase();
  if (looksLikeJson(bytes) || mediaType === "application/json" || mediaType.endsWith("+json")) return sanitizeJson(bytes);
  if (mediaType === "multipart/form-data" || multipartBoundary(null, bytes)) return sanitizeMultipart(bytes, contentType);
  if (mediaType === "application/x-www-form-urlencoded") return sanitizeUrlEncoded(bytes);
  if (bytes.length === 0) return replaceByteSpans(bytes, []);
  try {
    utf8.decode(bytes);
  } catch {
    fail("unknown binary request/response body");
  }
  return replaceByteSpans(bytes, genericTextCandidates(bytes));
}

function contentTypeFromMetadata(bytes) {
  const { strings } = scanJsonTokens(bytes);
  for (const token of strings) {
    if (token.isKey) continue;
    const last = pathStrings(token.path).at(-1)?.toLowerCase();
    if (last === "content-type" || last === "mimetype") return token.value;
  }
  return null;
}

function validatePolicy() {
  if (policy.schema !== "openai-cyber-verification-country-support/redaction-policy/v1" || SANITIZER_VERSION !== "1.0.0" || REPLACEMENT !== "[REDACTED]") fail("unsupported redaction policy");
}

async function secureRead(path, rawRoot) {
  const resolvedRawRoot = await realpath(rawRoot);
  const resolvedPath = await realpath(path);
  assertInside(resolvedRawRoot, resolvedPath);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("raw artifact is not a regular non-symlink file");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function artifactLocations(rawPath, rawRoot, stagingRoot) {
  if (typeof rawPath !== "string" || rawPath === "" || isAbsolute(rawPath) || rawPath.includes("\\")) fail("manifest contains an invalid artifact path");
  const source = resolve(repoRoot, rawPath);
  assertInside(rawRoot, source);
  const rel = relative(rawRoot, source);
  if (!rel || rel.startsWith("..") || rel.startsWith(sep)) fail("artifact path is outside the raw run");
  const destination = resolve(stagingRoot, rel);
  assertInside(stagingRoot, destination);
  const manifestPath = relative(stagingRoot, destination).split(sep).join("/");
  return { source, destination, manifestPath };
}

async function writeSanitizedArtifact(rawPath, rawRoot, stagingRoot, sanitizer) {
  const locations = artifactLocations(rawPath, rawRoot, stagingRoot);
  const rawBytes = await secureRead(locations.source, rawRoot);
  const result = sanitizer(rawBytes);
  await prepareRuntime(repoRoot, dirname(locations.destination));
  const written = await atomicWrite(locations.destination, result.bytes);
  await atomicJson(`${locations.destination}.redactions.json`, {
    schema: "openai-cyber-verification-country-support/redaction-manifest/v1",
    sanitizer_version: SANITIZER_VERSION,
    artifact: locations.manifestPath,
    raw: { bytes: rawBytes.length, sha256: sha256(rawBytes) },
    sanitized: { bytes: written.bytes, sha256: written.sha256 },
    changes: result.changes
  });
  return { ...locations, rawBytes, sanitizedBytes: result.bytes, written };
}

function safeCountryTransition(transition, previousIndex) {
  if (!transition || !Number.isSafeInteger(transition.index) || transition.index < 0 || (previousIndex !== null && transition.index !== previousIndex + 1)) fail("transition indexes must be contiguous and ordered");
  if (typeof transition.code !== "string" || !/^[A-Z]{2}$/.test(transition.code)) fail("country code is not canonical ISO alpha-2");
  if (typeof transition.name !== "string" || transition.name.length < 2 || transition.name.length > 100 || !/^[\p{L}\p{M} .,'’()&-]+$/u.test(transition.name)) fail("country name is not a safe display value");
  for (const field of ["selected_at", "submitted_at", "result_at"]) {
    if (typeof transition[field] !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(transition[field])) fail(`transition ${field} is invalid`);
  }
  if (!transition.request || !transition.response || !Number.isInteger(transition.response.http_status) || transition.response.http_status < 100 || transition.response.http_status > 599) fail("transition network metadata is invalid");
}

function canonicalIdclasses(responseBytes) {
  let response;
  try {
    response = JSON.parse(utf8.decode(responseBytes));
  } catch {
    return [];
  }
  const idclasses = response?.data?.attributes?.["next-step"]?.config?.idclasses;
  return Array.isArray(idclasses) ? idclasses : [];
}

validatePolicy();
const allowPartial = process.argv[2] === "--allow-partial";
const runId = process.argv[allowPartial ? 3 : 2];
if (process.argv.length !== (allowPartial ? 4 : 3) || typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) fail("usage: node scripts/sanitize-capture.mjs [--allow-partial] <run-id>");
const rawRoot = resolve(repoRoot, "runtime", "raw", runId);
const stagingRoot = resolve(repoRoot, "runtime", "sanitized-staging", runId);
const rawManifestBytes = await secureRead(resolve(rawRoot, "manifest.json"), rawRoot);
let rawManifest;
try {
  rawManifest = JSON.parse(utf8.decode(rawManifestBytes));
} catch {
  fail("raw manifest is not valid UTF-8 JSON");
}
if (rawManifest.schema !== "openai-cyber-verification-country-support/raw-capture/v1" || rawManifest.run_id !== runId || rawManifest.status !== "completed" || !Array.isArray(rawManifest.transitions)) fail("raw manifest contract mismatch");
if (!allowPartial && (rawManifest.range?.start !== 0 || rawManifest.range?.end !== rawManifest.option_count - 1 ||
    rawManifest.transitions.length !== rawManifest.option_count)) fail("raw capture is incomplete");

await prepareRuntime(repoRoot, stagingRoot);
const sanitizedTransitions = [];
const canonicalCountries = {};
const countryCodes = [];
let previousTransitionIndex = null;
for (let index = 0; index < rawManifest.transitions.length; index += 1) {
  const transition = rawManifest.transitions[index];
  safeCountryTransition(transition, previousTransitionIndex);
  previousTransitionIndex = transition.index;
  if (Object.hasOwn(canonicalCountries, transition.code)) fail("duplicate country code in raw manifest");
  const requestMeta = await writeSanitizedArtifact(transition.request.meta_path, rawRoot, stagingRoot, sanitizeJson);
  const requestContentType = contentTypeFromMetadata(requestMeta.rawBytes);
  const requestBody = await writeSanitizedArtifact(transition.request.body_path, rawRoot, stagingRoot, bytes => sanitizeBody(bytes, requestContentType));
  if (transition.request.bytes !== requestBody.rawBytes.length || transition.request.sha256 !== sha256(requestBody.rawBytes)) fail("request body does not match raw manifest custody data");
  const responseMeta = await writeSanitizedArtifact(transition.response.meta_path, rawRoot, stagingRoot, sanitizeJson);
  const responseContentType = contentTypeFromMetadata(responseMeta.rawBytes);
  const responseBody = await writeSanitizedArtifact(transition.response.body_path, rawRoot, stagingRoot, bytes => sanitizeBody(bytes, responseContentType));
  if (transition.response.bytes !== responseBody.rawBytes.length || transition.response.sha256 !== sha256(responseBody.rawBytes)) fail("response body does not match raw manifest custody data");
  const idclasses = canonicalIdclasses(responseBody.sanitizedBytes);
  countryCodes.push(transition.code);
  canonicalCountries[transition.code] = { name: transition.name, supported: idclasses.length > 0, request_count: 1, response_count: 1, idclasses };
  sanitizedTransitions.push({
    index: transition.index,
    code: transition.code,
    name: transition.name,
    selected_at: transition.selected_at,
    submitted_at: transition.submitted_at,
    result_at: transition.result_at,
    request: {
      meta_path: requestMeta.manifestPath,
      body_path: requestBody.manifestPath,
      bytes: requestBody.written.bytes,
      sha256: requestBody.written.sha256,
    },
    response: {
      meta_path: responseMeta.manifestPath,
      body_path: responseBody.manifestPath,
      http_status: transition.response.http_status,
      bytes: responseBody.written.bytes,
      sha256: responseBody.written.sha256,
    },
    screenshots: {
      selected_path: null,
      result_path: null,
      widget_selected_path: null,
      widget_result_path: null,
      comparison_path: null,
    },
  });
}

await atomicJson(resolve(stagingRoot, "manifest.json"), {
  schema: "openai-cyber-verification-country-support/sanitized-capture/v1",
  sanitizer_version: SANITIZER_VERSION,
  run_id: runId,
  transitions: sanitizedTransitions
});
await atomicJson(resolve(stagingRoot, "canonical-support-map.json"), {
  schema: "openai-cyber-verification-country-support/canonical-support-map/v1",
  sanitizer_version: SANITIZER_VERSION,
  run_id: runId,
  country_codes: countryCodes,
  countries: canonicalCountries
});
console.log(`Sanitized ${sanitizedTransitions.length} country transitions for run ${runId}.`);
