#!/usr/bin/env node

import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPopulationEnrichment,
  enrichOfficialComparison,
  officialComparisonCsv,
  parseOwidPopulationCsv,
  POPULATION_CSV_URL,
  populationEnrichmentCsv,
  POPULATION_METADATA_URL,
  POPULATION_SOURCE_LABEL,
  POPULATION_UNDERLYING_SOURCE_URL,
  POPULATION_YEAR,
} from "../lib/population.mjs";
import { atomicJson, atomicWrite, sha256 } from "../lib/runtime.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = resolve(repoRoot, "evidence");
const outputDirectory = resolve(evidenceRoot, "enrichment");
const populationJsonPath = resolve(outputDirectory, "population-2023.json");
const populationCsvPath = resolve(outputDirectory, "population-2023.csv");
const sourceMetadataPath = resolve(outputDirectory, "population-source-metadata.json");
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
  if (bytes.length < 1_000) throw new Error(`source download is unexpectedly small: ${url}`);
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
const [countryMap, officialComparison, manifest, populationCsvBytes, metadataBytes] = await Promise.all([
  readFile(resolve(evidenceRoot, "country-support.json"), "utf8").then(JSON.parse),
  readOptionalJson(comparisonJsonPath),
  readFile(manifestPath, "utf8").then(JSON.parse),
  fetchSource(POPULATION_CSV_URL),
  fetchSource(POPULATION_METADATA_URL),
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

const sourceMetadataDocument = JSON.parse(metadataBytes.toString("utf8"));
const populationColumn = sourceMetadataDocument.columns?.["Population (historical)"];
if (populationColumn?.owidVariableId !== 953903 || populationColumn.type !== "Integer" ||
    !populationColumn.descriptionProcessing?.includes("1950–2023") ||
    !populationColumn.descriptionProcessing?.includes("World Population Prospects (2024 revision)")) {
  throw new Error("OWID population metadata no longer identifies the expected UN WPP 2024 series");
}

const sourceRecords = parseOwidPopulationCsv(populationCsvBytes.toString("utf8"));
const enrichment = buildPopulationEnrichment(countryMap.results, sourceRecords);
if (enrichment.summary.matched !== 237 || enrichment.summary.not_covered_by_primary_source !== 13 ||
    enrichment.summary.missing_codes.join(",") !== "AX,AQ,BV,IO,CX,CC,TF,HM,XK,NF,PN,GS,UM") {
  throw new Error("population coverage changed from the reviewed 237 matched / 13 uncovered contract");
}

const fetchedAt = new Date().toISOString();
const sourceMetadata = {
  schema: "openai-cyber-verification-country-support/population-source-metadata/v1",
  fetched_at: fetchedAt,
  reference_year: POPULATION_YEAR,
  source: {
    label: POPULATION_SOURCE_LABEL,
    underlying_source: "United Nations, World Population Prospects 2024 revision",
    underlying_source_url: POPULATION_UNDERLYING_SOURCE_URL,
    distribution: {
      url: POPULATION_CSV_URL,
      bytes: populationCsvBytes.length,
      sha256: sha256(populationCsvBytes),
      format: "CSV",
    },
    metadata: {
      url: POPULATION_METADATA_URL,
      bytes: metadataBytes.length,
      sha256: sha256(metadataBytes),
      owid_variable_id: populationColumn.owidVariableId,
      last_updated: populationColumn.lastUpdated,
      citation: populationColumn.citationLong,
      chart_note: sourceMetadataDocument.chart?.note ?? null,
      source_reported_download_date: sourceMetadataDocument.dateDownloaded ?? null,
    },
  },
  method: {
    canonical_entries: 250,
    matched_entries: enrichment.summary.matched,
    uncovered_entries: enrichment.summary.not_covered_by_primary_source,
    matching: "Canonical selector names plus reviewed exact-name aliases; source rows require three-letter ISO codes; duplicate names, codes, aliases, and source-record reuse fail closed.",
    missing_values: "Entries absent from the primary source remain null and are not interpreted as zero.",
    territory_overlap_caveat: "Territory populations can overlap parent-country totals; population sums across selector entries are not necessarily mutually exclusive.",
    uncovered_codes: enrichment.summary.missing_codes,
  },
};
const enrichedComparison = officialComparison
  ? enrichOfficialComparison(officialComparison, enrichment)
  : null;

const writes = [
  [populationJsonPath, () => atomicJson(populationJsonPath, enrichment)],
  [populationCsvPath, () => atomicWrite(populationCsvPath, populationEnrichmentCsv(enrichment))],
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
  ["evidence/enrichment/population-2023.json", "population-enrichment"],
  ["evidence/enrichment/population-2023.csv", "population-enrichment-csv"],
  ["evidence/enrichment/population-source-metadata.json", "population-source-metadata"],
]);
const pathByRelative = new Map([
  ["evidence/enrichment/population-2023.json", populationJsonPath],
  ["evidence/enrichment/population-2023.csv", populationCsvPath],
  ["evidence/enrichment/population-source-metadata.json", sourceMetadataPath],
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
  reference_year: POPULATION_YEAR,
  matched: enrichment.summary.matched,
  not_covered_by_primary_source: enrichment.summary.not_covered_by_primary_source,
  official_supported_population_with_cyber_verification_percent: enrichedComparison
    ? enrichedComparison.summary.population_weighted.official_supported_population_with_cyber_verification_percent
    : null,
}));
