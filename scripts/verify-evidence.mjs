#!/usr/bin/env node

import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  enrichOfficialComparison,
  officialComparisonCsv,
  populationEnrichmentCsv,
} from "../lib/population.mjs";
import {
  enrichOfficialComparisonWithSanctions,
  sanctionsEnrichmentCsv,
  INCLUDED_SANCTIONS_MEASURES,
} from "../lib/sanctions-programs.mjs";
import { sha256 } from "../lib/runtime.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = resolve(repoRoot, "evidence");

async function inventory(directory, base = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const path = resolve(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error("symlink under evidence");
    if (entry.isDirectory()) files.push(...await inventory(path, base));
    else if (entry.isFile()) files.push(`evidence/${relative(base, path).split(sep).join("/")}`);
    else throw new Error("special file under evidence");
  }
  return files;
}

const manifest = JSON.parse(await readFile(resolve(evidenceRoot, "manifest.json"), "utf8"));
if (manifest.schema !== "openai-cyber-verification-country-support/evidence-manifest/v1" || !Array.isArray(manifest.files)) {
  throw new Error("evidence manifest contract mismatch");
}
const declared = new Set();
for (const entry of manifest.files) {
  if (declared.has(entry.path) || !entry.path.startsWith("evidence/") || entry.path.includes("..")) {
    throw new Error("invalid or duplicate evidence manifest path");
  }
  declared.add(entry.path);
  const bytes = await readFile(resolve(repoRoot, entry.path));
  if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error("evidence manifest hash mismatch");
}
const actual = new Set((await inventory(evidenceRoot)).filter(path => path !== "evidence/manifest.json"));
if (actual.size !== declared.size || [...actual].some(path => !declared.has(path))) {
  throw new Error("evidence manifest inventory mismatch");
}

const map = JSON.parse(await readFile(resolve(evidenceRoot, "country-support.json"), "utf8"));
if (map.summary.total !== 250 || map.results.length !== 250 || map.summary.unique_codes !== 250 ||
    map.summary.supported + map.summary.unsupported !== 250 || new Set(map.results.map(row => row.code)).size !== 250) {
  throw new Error("canonical country map counts are invalid");
}
const population = JSON.parse(await readFile(resolve(evidenceRoot, "enrichment/population-2023.json"), "utf8"));
const populationMetadata = JSON.parse(await readFile(
  resolve(evidenceRoot, "enrichment/population-source-metadata.json"), "utf8"));
const populationCsv = await readFile(resolve(evidenceRoot, "enrichment/population-2023.csv"), "utf8");
if (population.schema !== "openai-cyber-verification-country-support/population-enrichment/v1" ||
    population.results?.length !== 250 ||
    population.summary.matched !== 237 ||
    population.summary.not_covered_by_primary_source !== 13 ||
    population.summary.missing_codes.join(",") !== "AX,AQ,BV,IO,CX,CC,TF,HM,XK,NF,PN,GS,UM" ||
    population.results.some((row, index) =>
      row.code !== map.results[index].code ||
      row.index !== map.results[index].index ||
      (row.population_status === "matched"
        ? !/^[A-Z]{3}$/u.test(row.iso3) || !Number.isSafeInteger(row.population) || row.population < 0 ||
          row.population_year !== 2023
        : row.population_status !== "not-covered-by-primary-source" ||
          row.iso3 !== null || row.population !== null || row.population_year !== null)) ||
    populationCsv !== populationEnrichmentCsv(population)) {
  throw new Error("population enrichment is inconsistent with the canonical map");
}
if (populationMetadata.schema !== "openai-cyber-verification-country-support/population-source-metadata/v1" ||
    populationMetadata.reference_year !== 2023 ||
    populationMetadata.method?.matched_entries !== 237 ||
    populationMetadata.method?.uncovered_entries !== 13 ||
    !/^[a-f0-9]{64}$/u.test(populationMetadata.source?.distribution?.sha256 ?? "") ||
    !/^[a-f0-9]{64}$/u.test(populationMetadata.source?.metadata?.sha256 ?? "")) {
  throw new Error("population source metadata contract mismatch");
}
const sanctions = JSON.parse(await readFile(
  resolve(evidenceRoot, "enrichment/us-sanctions-programs.json"), "utf8"));
const sanctionsMetadata = JSON.parse(await readFile(
  resolve(evidenceRoot, "enrichment/us-sanctions-source-metadata.json"), "utf8"));
const sanctionsCsv = await readFile(resolve(evidenceRoot, "enrichment/us-sanctions-programs.csv"), "utf8");
const sanctionsProgramKeys = new Set(sanctions.programs?.map(program => program.key));
const includedMeasures = new Set(INCLUDED_SANCTIONS_MEASURES);
const sanctionsEntriesWithPrograms = sanctions.results?.filter(result => result.program_ids.length > 0).length;
const sanctionsAssignments = sanctions.results?.reduce((sum, result) => sum + result.program_ids.length, 0);
if (sanctions.schema !== "openai-cyber-verification-country-support/us-sanctions-programs/v1" ||
    sanctions.results?.length !== 250 ||
    !Array.isArray(sanctions.programs) ||
    sanctionsProgramKeys.size !== sanctions.programs.length ||
    sanctions.programs.some(program =>
      program.status !== "active" ||
      program.issuer?.territory !== "us" ||
      !Array.isArray(program.relevant_measures) ||
      program.relevant_measures.length === 0 ||
      program.relevant_measures.some(measure => !includedMeasures.has(measure))) ||
    sanctions.results.some((result, index) =>
      result.code !== map.results[index].code ||
      result.index !== map.results[index].index ||
      !Array.isArray(result.program_ids) ||
      new Set(result.program_ids).size !== result.program_ids.length ||
      result.program_ids.some(programId => !sanctionsProgramKeys.has(programId)) ||
      JSON.stringify(result.program_ids) !== JSON.stringify([...result.program_ids].sort((left, right) =>
        left.localeCompare(right)))) ||
    sanctions.summary.mapped_programs !== sanctions.programs.length ||
    sanctions.summary.entries_with_programs !== sanctionsEntriesWithPrograms ||
    sanctions.summary.entries_without_programs !== 250 - sanctionsEntriesWithPrograms ||
    sanctions.summary.program_assignments !== sanctionsAssignments ||
    sanctionsCsv !== sanctionsEnrichmentCsv(sanctions)) {
  throw new Error("sanctions enrichment is inconsistent with the canonical map and selected programs");
}
if (sanctionsMetadata.schema !==
      "openai-cyber-verification-country-support/us-sanctions-source-metadata/v1" ||
    sanctionsMetadata.method?.canonical_entries !== 250 ||
    sanctionsMetadata.method?.selected_active_us_programs !==
      sanctions.summary.selected_active_us_programs ||
    sanctionsMetadata.method?.mapped_programs !== sanctions.summary.mapped_programs ||
    sanctionsMetadata.method?.entries_with_programs !== sanctions.summary.entries_with_programs ||
    JSON.stringify(sanctionsMetadata.method?.included_measures) !==
      JSON.stringify(INCLUDED_SANCTIONS_MEASURES) ||
    sanctionsMetadata.source?.license !== "CC BY-NC 4.0" ||
    !/^[a-f0-9]{64}$/u.test(sanctionsMetadata.source?.sha256 ?? "")) {
  throw new Error("sanctions source metadata contract mismatch");
}
const officialComparison = JSON.parse(await readFile(
  resolve(evidenceRoot, "comparisons/openai-chatgpt-supported-countries.json"), "utf8"));
const officialComparisonCsvText = await readFile(
  resolve(evidenceRoot, "comparisons/openai-chatgpt-supported-countries.csv"), "utf8");
const comparisonSummary = officialComparison.summary;
const recomputedComparison = enrichOfficialComparisonWithSanctions(
  enrichOfficialComparison(officialComparison, population),
  sanctions,
);
const recomputedWeighted = recomputedComparison.summary.population_weighted;
if (officialComparison.schema !== "openai-cyber-verification-country-support/official-access-comparison/v3" ||
    officialComparison.results?.length !== 250 ||
    comparisonSummary.official_and_cyber_supported +
      comparisonSummary.official_supported_cyber_unsupported +
      comparisonSummary.cyber_supported_not_official +
      comparisonSummary.neither_supported !== 250 ||
    comparisonSummary.population_entries_with_data !== 237 ||
    comparisonSummary.population_entries_without_data !== 13 ||
    JSON.stringify(comparisonSummary.population_weighted) !== JSON.stringify(recomputedWeighted) ||
    comparisonSummary.sanctions_entries_with_programs !==
      recomputedComparison.summary.sanctions_entries_with_programs ||
    comparisonSummary.sanctions_program_assignments !==
      recomputedComparison.summary.sanctions_program_assignments ||
    comparisonSummary.sanctions_chatgpt_unavailable_entries_with_programs !==
      recomputedComparison.summary.sanctions_chatgpt_unavailable_entries_with_programs ||
    comparisonSummary.sanctions_official_supported_cyber_unsupported_entries_with_programs !==
      recomputedComparison.summary.sanctions_official_supported_cyber_unsupported_entries_with_programs ||
    officialComparisonCsvText !== officialComparisonCsv(officialComparison) ||
    officialComparison.results.some((row, index) =>
      row.code !== map.results[index].code ||
      row.cyber_verification_supported !== map.results[index].supported ||
      row.iso3 !== population.results[index].iso3 ||
      row.population !== population.results[index].population ||
      row.population_year !== population.results[index].population_year ||
      row.population_status !== population.results[index].population_status ||
      JSON.stringify(row.active_us_sanctions_program_ids) !==
        JSON.stringify(sanctions.results[index].program_ids))) {
  throw new Error("official access comparison is inconsistent with the canonical map and enrichments");
}
const fullScreenshots = [...actual].filter(path => path.startsWith("evidence/screenshots/countries/") && path.endsWith(".webp"));
const widgetScreenshots = [...actual].filter(path => path.startsWith("evidence/screenshots/widgets/") && path.endsWith(".webp"));
const comparisons = [...actual].filter(path => path.startsWith("evidence/screenshots/comparisons/") && path.endsWith(".webp"));
if (fullScreenshots.length !== 500 || widgetScreenshots.length !== 500 || comparisons.length !== 250 ||
    map.results.some(row => {
      const stem = `${String(row.index).padStart(4, "0")}-${row.code}`;
      return !actual.has(`evidence/screenshots/countries/${stem}-selected.webp`) ||
        !actual.has(`evidence/screenshots/countries/${stem}-result.webp`) ||
        !actual.has(`evidence/screenshots/widgets/${stem}-widget-selected.webp`) ||
        !actual.has(`evidence/screenshots/widgets/${stem}-widget-result.webp`) ||
        !actual.has(`evidence/screenshots/comparisons/${stem}-widget-comparison.webp`);
    })) {
  throw new Error("country screenshot and widget comparison sets are incomplete");
}
for (const [prefix, expected] of [
  ["evidence/sanitized-transitions/requests/", 500],
  ["evidence/sanitized-transitions/responses/", 500],
  ["evidence/sanitized-transitions/redactions/", 1000],
]) {
  if ([...actual].filter(path => path.startsWith(prefix)).length !== expected) {
    throw new Error(`sanitized transition inventory mismatch: ${prefix}`);
  }
}

const chapters = JSON.parse(await readFile(resolve(evidenceRoot, "video/representative/chapters.json"), "utf8"));
const unsupported = map.results.filter(row => !row.supported);
if (chapters.chapters.length !== unsupported.length || chapters.chapters.some((chapter, index) => chapter.code !== unsupported[index].code)) {
  throw new Error("representative video chapters do not match unsupported countries");
}
const video = resolve(evidenceRoot, "video/representative/unsupported-country-transitions.mp4");
const probe = JSON.parse((await execFileAsync("ffprobe", [
  "-v", "error", "-show_entries", "format=duration,size:stream=codec_name,pix_fmt,width,height,r_frame_rate",
  "-of", "json", video,
])).stdout);
const stream = probe.streams?.[0];
if (stream?.codec_name !== "h264" || stream.pix_fmt !== "yuv420p" || stream.width % 2 || stream.height % 2 ||
    Number(probe.format?.size) >= 100 * 1024 * 1024) {
  throw new Error("representative video format or size is invalid");
}
console.log(JSON.stringify({
  files: actual.size,
  countries: map.summary.total,
  supported: map.summary.supported,
  unsupported: map.summary.unsupported,
  screenshots: fullScreenshots.length + widgetScreenshots.length + comparisons.length,
  official_chatgpt_supported: comparisonSummary.official_chatgpt_supported,
  official_supported_cyber_unsupported: comparisonSummary.official_supported_cyber_unsupported,
  population_reference_year: population.summary.population_reference_year,
  population_entries_with_data: population.summary.matched,
  population_entries_without_data: population.summary.not_covered_by_primary_source,
  sanctions_mapped_programs: sanctions.summary.mapped_programs,
  sanctions_entries_with_programs: sanctions.summary.entries_with_programs,
  video_chapters: chapters.chapters.length,
  video_bytes: Number(probe.format.size),
  video_duration_seconds: Number(probe.format.duration),
}));
