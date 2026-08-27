#!/usr/bin/env node

import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { officialComparisonCsv } from "../lib/population.mjs";
import { atomicJson, atomicWrite, sha256 } from "../lib/runtime.mjs";
import {
  buildSanctionsEnrichment,
  enrichOfficialComparisonWithSanctions,
  OPENSANCTIONS_LICENSE,
  OPENSANCTIONS_LICENSE_URL,
  OPENSANCTIONS_PROGRAMS_DOCS_URL,
  OPENSANCTIONS_PROGRAMS_URL,
  parseOpenSanctionsPrograms,
  sanctionsEnrichmentCsv,
  INCLUDED_SANCTIONS_MEASURES,
} from "../lib/sanctions-programs.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = resolve(repoRoot, "evidence");
const outputDirectory = resolve(evidenceRoot, "enrichment");
const sanctionsJsonPath = resolve(outputDirectory, "us-sanctions-programs.json");
const sanctionsCsvPath = resolve(outputDirectory, "us-sanctions-programs.csv");
const sourceMetadataPath = resolve(outputDirectory, "us-sanctions-source-metadata.json");
const comparisonJsonPath = resolve(evidenceRoot, "comparisons/openai-chatgpt-supported-countries.json");
const comparisonCsvPath = resolve(evidenceRoot, "comparisons/openai-chatgpt-supported-countries.csv");
const manifestPath = resolve(evidenceRoot, "manifest.json");

async function fetchSource(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "openai-cyber-verification-country-support/1.0" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`source download failed (${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 10_000) throw new Error(`source download is unexpectedly small: ${url}`);
  return bytes;
}

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

await mkdir(outputDirectory, { recursive: true });
const [countryMap, officialComparison, manifest, sourceBytes] = await Promise.all([
  readFile(resolve(evidenceRoot, "country-support.json"), "utf8").then(JSON.parse),
  readOptionalJson(comparisonJsonPath),
  readFile(manifestPath, "utf8").then(JSON.parse),
  fetchSource(OPENSANCTIONS_PROGRAMS_URL),
]);
if (countryMap.schema !== "openai-cyber-verification-country-support/v1" || countryMap.results?.length !== 250) {
  throw new Error("canonical cyber country map is unavailable");
}
if (officialComparison &&
    (!officialComparison.schema?.startsWith("openai-cyber-verification-country-support/official-access-comparison/") ||
      officialComparison.results?.length !== 250)) {
  throw new Error("existing official access comparison is invalid");
}
if (manifest.schema !== "openai-cyber-verification-country-support/evidence-manifest/v1" || !Array.isArray(manifest.files)) {
  throw new Error("evidence manifest is unavailable");
}

const sourceDocument = JSON.parse(sourceBytes.toString("utf8"));
const sourcePrograms = parseOpenSanctionsPrograms(sourceDocument);
if (sourcePrograms.length < 200) throw new Error("OpenSanctions program directory is unexpectedly incomplete");
const enrichment = buildSanctionsEnrichment(countryMap.results, sourcePrograms);
if (enrichment.summary.canonical_country_entries !== 250 ||
    enrichment.summary.entries_with_programs + enrichment.summary.entries_without_programs !== 250 ||
    enrichment.results.some((result, index) =>
      result.code !== countryMap.results[index].code || result.index !== countryMap.results[index].index)) {
  throw new Error("sanctions enrichment does not align with the canonical country map");
}

const fetchedAt = new Date().toISOString();
const sourceMetadata = {
  schema: "openai-cyber-verification-country-support/us-sanctions-source-metadata/v1",
  fetched_at: fetchedAt,
  source: {
    name: "OpenSanctions sanctions program directory",
    distribution_url: OPENSANCTIONS_PROGRAMS_URL,
    documentation_url: OPENSANCTIONS_PROGRAMS_DOCS_URL,
    bytes: sourceBytes.length,
    sha256: sha256(sourceBytes),
    format: "JSON",
    attribution: "Contains data from OpenSanctions (opensanctions.org).",
    license: OPENSANCTIONS_LICENSE,
    license_url: OPENSANCTIONS_LICENSE_URL,
  },
  method: {
    canonical_entries: 250,
    issuer_territory: "us",
    program_status: "active",
    included_measures: INCLUDED_SANCTIONS_MEASURES,
    source_programs: enrichment.summary.source_programs,
    active_us_programs: enrichment.summary.active_us_programs,
    selected_active_us_programs: enrichment.summary.selected_active_us_programs,
    mapped_programs: enrichment.summary.mapped_programs,
    entries_with_programs: enrichment.summary.entries_with_programs,
    entries_without_programs: enrichment.summary.entries_without_programs,
    mapping: "OpenSanctions target_territories values are matched case-insensitively to the canonical two-letter selector codes.",
  },
};
const enrichedComparison = officialComparison
  ? enrichOfficialComparisonWithSanctions(officialComparison, enrichment)
  : null;

const writes = [
  [sanctionsJsonPath, () => atomicJson(sanctionsJsonPath, enrichment)],
  [sanctionsCsvPath, () => atomicWrite(sanctionsCsvPath, sanctionsEnrichmentCsv(enrichment))],
  [sourceMetadataPath, () => atomicJson(sourceMetadataPath, sourceMetadata)],
];
if (enrichedComparison) {
  writes.push(
    [comparisonJsonPath, () => atomicJson(comparisonJsonPath, enrichedComparison)],
    [comparisonCsvPath, () => atomicWrite(comparisonCsvPath, officialComparisonCsv(enrichedComparison))],
  );
}
await Promise.all(writes.map(([, writeOutput]) => writeOutput()));
for (const [path] of writes) await chmod(path, 0o644);

const outputKinds = new Map([
  ["evidence/enrichment/us-sanctions-programs.json", "us-sanctions-program-enrichment"],
  ["evidence/enrichment/us-sanctions-programs.csv", "us-sanctions-program-enrichment-csv"],
  ["evidence/enrichment/us-sanctions-source-metadata.json", "us-sanctions-source-metadata"],
]);
const pathByRelative = new Map([
  ["evidence/enrichment/us-sanctions-programs.json", sanctionsJsonPath],
  ["evidence/enrichment/us-sanctions-programs.csv", sanctionsCsvPath],
  ["evidence/enrichment/us-sanctions-source-metadata.json", sourceMetadataPath],
]);
if (enrichedComparison) {
  outputKinds.set("evidence/comparisons/openai-chatgpt-supported-countries.json", "official-access-comparison");
  outputKinds.set("evidence/comparisons/openai-chatgpt-supported-countries.csv", "official-access-comparison-csv");
  pathByRelative.set("evidence/comparisons/openai-chatgpt-supported-countries.json", comparisonJsonPath);
  pathByRelative.set("evidence/comparisons/openai-chatgpt-supported-countries.csv", comparisonCsvPath);
}
const entries = [];
for (const [relativePath, kind] of outputKinds) {
  const bytes = await readFile(pathByRelative.get(relativePath));
  entries.push({ path: relativePath, kind, bytes: bytes.length, sha256: sha256(bytes) });
}
manifest.files = manifest.files.filter(entry => !outputKinds.has(entry.path));
manifest.files.push(...entries);
manifest.files.sort((left, right) => left.path.localeCompare(right.path));
await atomicJson(manifestPath, manifest);
await chmod(manifestPath, 0o644);

console.log(JSON.stringify({
  source_programs: enrichment.summary.source_programs,
  active_us_programs: enrichment.summary.active_us_programs,
  selected_active_us_programs: enrichment.summary.selected_active_us_programs,
  mapped_programs: enrichment.summary.mapped_programs,
  entries_with_programs: enrichment.summary.entries_with_programs,
  program_assignments: enrichment.summary.program_assignments,
}));
