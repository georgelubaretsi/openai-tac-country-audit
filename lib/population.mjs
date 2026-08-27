import { normalizeCountryName } from "./official-country-support.mjs";

export const POPULATION_YEAR = 2023;
export const POPULATION_CSV_URL = "https://ourworldindata.org/grapher/population.csv";
export const POPULATION_METADATA_URL = "https://ourworldindata.org/grapher/population.metadata.json";
export const POPULATION_SOURCE_LABEL = "UN WPP 2024 via Our World in Data";
export const POPULATION_UNDERLYING_SOURCE_URL = "https://population.un.org/wpp/";

export const POPULATION_NAME_ALIASES = Object.freeze({
  BN: "Brunei",
  CV: "Cape Verde",
  CD: "Democratic Republic of Congo",
  FK: "Falkland Islands",
  VA: "Vatican",
  LA: "Laos",
  FM: "Micronesia (country)",
  PS: "Palestine",
  RU: "Russia",
  SH: "Saint Helena",
  SY: "Syria",
  TL: "East Timor",
  TR: "Turkey",
  VG: "British Virgin Islands",
  VI: "United States Virgin Islands",
});

export function parseCsvRows(text) {
  if (typeof text !== "string" || text.length === 0) throw new Error("CSV input is empty");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let quoteClosed = false;

  const finishField = () => {
    row.push(field);
    field = "";
    quoteClosed = false;
  };
  const finishRow = () => {
    finishField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character !== '"') {
        field += character;
      } else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
        quoteClosed = true;
      }
      continue;
    }
    if (character === '"') {
      if (field || quoteClosed) throw new Error("CSV quote appears inside an unquoted field");
      quoted = true;
    } else if (character === ",") {
      finishField();
    } else if (character === "\n") {
      finishRow();
    } else if (character === "\r") {
      if (text[index + 1] !== "\n") throw new Error("CSV contains a bare carriage return");
    } else {
      if (quoteClosed) throw new Error("CSV contains characters after a closing quote");
      field += character;
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  if (field || row.length > 0 || quoteClosed) finishRow();
  return rows;
}

export function parseOwidPopulationCsv(text, year = POPULATION_YEAR) {
  const rows = parseCsvRows(text);
  if (rows.length < 2 || rows[0].join(",") !== "Entity,Code,Year,Population") {
    throw new Error("OWID population CSV header is unexpected");
  }
  const records = [];
  const codes = new Set();
  const names = new Set();
  for (const row of rows.slice(1)) {
    if (row.length !== 4) throw new Error("OWID population CSV row has an unexpected column count");
    const [entity, iso3, sourceYear, value] = row;
    if (Number(sourceYear) !== year || !/^[A-Z]{3}$/u.test(iso3)) continue;
    if (!/^\d+$/u.test(value)) throw new Error(`population is not an integer for ${entity}`);
    const population = Number(value);
    if (!Number.isSafeInteger(population) || population < 0) throw new Error(`population is invalid for ${entity}`);
    const normalizedName = normalizeCountryName(entity);
    if (codes.has(iso3) || names.has(normalizedName)) {
      throw new Error(`OWID population records are ambiguous for ${entity}`);
    }
    codes.add(iso3);
    names.add(normalizedName);
    records.push({ entity, iso3, year, population });
  }
  if (records.length === 0) throw new Error(`OWID population CSV has no ISO-3 records for ${year}`);
  return records;
}

export function buildPopulationEnrichment(cyberResults, sourceRecords) {
  if (!Array.isArray(cyberResults) || cyberResults.length === 0 || !Array.isArray(sourceRecords)) {
    throw new Error("population enrichment inputs have unexpected shapes");
  }
  const sourceByName = new Map();
  const sourceCodes = new Set();
  for (const record of sourceRecords) {
    if (!/^[A-Z]{3}$/u.test(record.iso3 ?? "") || record.year !== POPULATION_YEAR ||
        !Number.isSafeInteger(record.population) || record.population < 0) {
      throw new Error("population source record is invalid");
    }
    const normalizedName = normalizeCountryName(record.entity);
    if (sourceByName.has(normalizedName) || sourceCodes.has(record.iso3)) {
      throw new Error(`population source record is ambiguous: ${record.entity}`);
    }
    sourceByName.set(normalizedName, record);
    sourceCodes.add(record.iso3);
  }

  const canonicalCodes = new Set();
  const usedSourceCodes = new Set();
  const results = cyberResults.map(result => {
    if (!Number.isInteger(result.index) || !/^[A-Z]{2}$/u.test(result.code ?? "") ||
        typeof result.name !== "string" || canonicalCodes.has(result.code)) {
      throw new Error("canonical country result is invalid or ambiguous");
    }
    canonicalCodes.add(result.code);
    const alias = POPULATION_NAME_ALIASES[result.code];
    const sourceName = alias ?? result.name;
    const record = sourceByName.get(normalizeCountryName(sourceName));
    if (alias && !record) throw new Error(`population alias is unmapped: ${result.code} -> ${alias}`);
    if (record && usedSourceCodes.has(record.iso3)) {
      throw new Error(`population source record is reused: ${record.iso3}`);
    }
    if (record) usedSourceCodes.add(record.iso3);
    return {
      index: result.index,
      code: result.code,
      iso3: record?.iso3 ?? null,
      name: result.name,
      population: record?.population ?? null,
      population_year: record?.year ?? null,
      population_source: POPULATION_SOURCE_LABEL,
      population_source_url: POPULATION_CSV_URL,
      population_status: record ? "matched" : "not-covered-by-primary-source",
    };
  });

  const matched = results.filter(result => result.population_status === "matched");
  const missing = results.filter(result => result.population_status !== "matched");
  return {
    schema: "openai-cyber-verification-country-support/population-enrichment/v1",
    source: {
      label: POPULATION_SOURCE_LABEL,
      distribution_url: POPULATION_CSV_URL,
      metadata_url: POPULATION_METADATA_URL,
      underlying_source_url: POPULATION_UNDERLYING_SOURCE_URL,
      reference_year: POPULATION_YEAR,
      metadata_path: "evidence/enrichment/population-source-metadata.json",
    },
    summary: {
      canonical_country_entries: results.length,
      population_reference_year: POPULATION_YEAR,
      matched: matched.length,
      not_covered_by_primary_source: missing.length,
      matched_population_total: matched.reduce((sum, result) => sum + result.population, 0),
      missing_codes: missing.map(result => result.code),
    },
    results,
  };
}

function aggregatePopulation(results, predicate) {
  const selected = results.filter(predicate);
  const covered = selected.filter(result => result.population !== null);
  return {
    population: covered.reduce((sum, result) => sum + result.population, 0),
    country_entries_with_population: covered.length,
    country_entries_without_population: selected.length - covered.length,
  };
}

export function enrichOfficialComparison(comparison, populationEnrichment) {
  if (!comparison || !Array.isArray(comparison.results) || !populationEnrichment ||
      populationEnrichment.schema !== "openai-cyber-verification-country-support/population-enrichment/v1" ||
      !Array.isArray(populationEnrichment.results) ||
      comparison.results.length !== populationEnrichment.results.length) {
    throw new Error("official comparison and population enrichment shapes do not align");
  }
  const results = comparison.results.map((result, index) => {
    const population = populationEnrichment.results[index];
    if (result.code !== population.code || result.index !== population.index) {
      throw new Error("official comparison and population enrichment order does not align");
    }
    return {
      ...result,
      iso3: population.iso3,
      population: population.population,
      population_year: population.population_year,
      population_status: population.population_status,
    };
  });
  const weighted = {
    reference_year: POPULATION_YEAR,
    territory_overlap_caveat: "Territory populations can overlap parent-country totals; sums are selector-entry aggregates, not mutually exclusive world population.",
    canonical_selector_entries: aggregatePopulation(results, () => true),
    official_chatgpt_supported: aggregatePopulation(results, result => result.official_chatgpt_supported),
    cyber_verification_supported: aggregatePopulation(results, result => result.cyber_verification_supported),
    official_and_cyber_supported: aggregatePopulation(results, result => result.classification === "official-and-cyber-supported"),
    official_supported_cyber_unsupported: aggregatePopulation(results, result => result.classification === "official-supported-cyber-unsupported"),
    cyber_supported_not_official: aggregatePopulation(results, result => result.classification === "cyber-supported-not-official"),
    neither_supported: aggregatePopulation(results, result => result.classification === "neither-supported"),
  };
  const officialPopulation = weighted.official_chatgpt_supported.population;
  weighted.official_supported_population_with_cyber_verification_percent = officialPopulation === 0
    ? null
    : Number((weighted.official_and_cyber_supported.population / officialPopulation * 100).toFixed(2));

  return {
    ...comparison,
    schema: "openai-cyber-verification-country-support/official-access-comparison/v2",
    population_source: {
      label: POPULATION_SOURCE_LABEL,
      reference_year: POPULATION_YEAR,
      enrichment_path: "evidence/enrichment/population-2023.json",
      metadata_path: "evidence/enrichment/population-source-metadata.json",
    },
    summary: {
      ...comparison.summary,
      population_reference_year: POPULATION_YEAR,
      population_entries_with_data: populationEnrichment.summary.matched,
      population_entries_without_data: populationEnrichment.summary.not_covered_by_primary_source,
      population_weighted: weighted,
    },
    results,
  };
}

const csvCell = value => /[",\n]/u.test(String(value))
  ? `"${String(value).replaceAll('"', '""')}"`
  : String(value);

export function populationEnrichmentCsv(enrichment) {
  return [
    "index,code,iso3,name,population,population_year,population_source,population_source_url,population_status",
    ...enrichment.results.map(result => [
      result.index,
      result.code,
      result.iso3 ?? "",
      csvCell(result.name),
      result.population ?? "",
      result.population_year ?? "",
      csvCell(result.population_source),
      result.population_source_url,
      result.population_status,
    ].join(",")),
  ].join("\n") + "\n";
}

export function officialComparisonCsv(comparison) {
  return [
    "index,code,iso3,name,population,population_year,population_status,official_source_name,official_chatgpt_supported,cyber_verification_supported,classification",
    ...comparison.results.map(result => [
      result.index,
      result.code,
      result.iso3 ?? "",
      csvCell(result.name),
      result.population ?? "",
      result.population_year ?? "",
      result.population_status,
      csvCell(result.official_source_name ?? ""),
      result.official_chatgpt_supported,
      result.cyber_verification_supported,
      result.classification,
    ].join(",")),
  ].join("\n") + "\n";
}
