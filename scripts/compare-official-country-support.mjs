#!/usr/bin/env node

import { execFile } from "node:child_process";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  compareCountrySupport,
  OFFICIAL_SOURCE_URL,
  parseOfficialCountryNames,
} from "../lib/official-country-support.mjs";
import { atomicJson, atomicWrite, sha256 } from "../lib/runtime.mjs";
const execFileAsync = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = resolve(repoRoot, "evidence");
const mapPath = resolve(evidenceRoot, "country-support.json");
const manifestPath = resolve(evidenceRoot, "manifest.json");
const outputDirectory = resolve(evidenceRoot, "comparisons");
const jsonPath = resolve(outputDirectory, "openai-chatgpt-supported-countries.json");
const csvPath = resolve(outputDirectory, "openai-chatgpt-supported-countries.csv");

await mkdir(outputDirectory, { recursive: true });
const [countryMap, manifest] = await Promise.all([
  readFile(mapPath, "utf8").then(text => JSON.parse(text)),
  readFile(manifestPath, "utf8").then(text => JSON.parse(text)),
]);
if (countryMap.schema !== "openai-cyber-verification-country-support/v1" || countryMap.results?.length !== 250) {
  throw new Error("canonical cyber country map is unavailable");
}
if (manifest.schema !== "openai-cyber-verification-country-support/evidence-manifest/v1" || !Array.isArray(manifest.files)) {
  throw new Error("evidence manifest is unavailable");
}

async function fetchOfficialHtml() {
  try {
    const response = await fetch(OFFICIAL_SOURCE_URL, {
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/144 Safari/537.36",
        "accept": "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) return { html: await response.text(), transport: "fetch" };
  } catch { /* Fall through to curl for help-center edge compatibility. */ }
  const { stdout } = await execFileAsync("curl", [
    "-sS", "-L", "--fail",
    "-A", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/144 Safari/537.36",
    OFFICIAL_SOURCE_URL,
  ], { maxBuffer: 2 * 1024 * 1024 });
  return { html: stdout, transport: "curl" };
}

const { html, transport } = await fetchOfficialHtml();
const officialNames = parseOfficialCountryNames(html);
const comparison = compareCountrySupport(officialNames, countryMap.results);
const generated = {
  schema: "openai-cyber-verification-country-support/official-access-comparison/v1",
  source: {
    url: OFFICIAL_SOURCE_URL,
    fetched_at: new Date().toISOString(),
    html_sha256: sha256(Buffer.from(html)),
    title: "ChatGPT Supported Countries | OpenAI Help Center",
    description: "Countries, regions, and territories OpenAI currently supports access from.",
    transport,
  },
  summary: {
    canonical_country_entries: countryMap.results.length,
    ...comparison.summary,
  },
  official_entries: comparison.official_entries,
  results: comparison.results,
};
await atomicJson(jsonPath, generated);
await chmod(jsonPath, 0o644);

const csvCell = value => /[",\n]/u.test(String(value))
  ? `"${String(value).replaceAll('"', '""')}"`
  : String(value);
const csv = [
  "index,code,name,official_source_name,official_chatgpt_supported,cyber_verification_supported,classification",
  ...comparison.results.map(result => [
    result.index,
    result.code,
    csvCell(result.name),
    csvCell(result.official_source_name ?? ""),
    result.official_chatgpt_supported,
    result.cyber_verification_supported,
    result.classification,
  ].join(",")),
].join("\n") + "\n";
await atomicWrite(csvPath, csv);
await chmod(csvPath, 0o644);

const entries = [];
for (const [path, kind] of [[jsonPath, "official-access-comparison"], [csvPath, "official-access-comparison-csv"]]) {
  const bytes = await readFile(path);
  entries.push({
    path: `evidence/comparisons/${path.endsWith(".json") ? "openai-chatgpt-supported-countries.json" : "openai-chatgpt-supported-countries.csv"}`,
    kind,
    bytes: bytes.length,
    sha256: sha256(bytes),
  });
}
const comparisonPaths = new Set(entries.map(entry => entry.path));
manifest.files = manifest.files.filter(entry => !comparisonPaths.has(entry.path));
manifest.files.push(...entries);
manifest.files.sort((left, right) => left.path.localeCompare(right.path));
await atomicJson(manifestPath, manifest);
await chmod(manifestPath, 0o644);
console.log(JSON.stringify(generated.summary));
