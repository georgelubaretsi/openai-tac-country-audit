export const OPENSANCTIONS_PROGRAMS_URL = "https://data.opensanctions.org/meta/programs.json";
export const OPENSANCTIONS_PROGRAMS_DOCS_URL = "https://www.opensanctions.org/docs/programs/";
export const OPENSANCTIONS_LICENSE = "CC BY-NC 4.0";
export const OPENSANCTIONS_LICENSE_URL = "https://creativecommons.org/licenses/by-nc/4.0/";

export const INCLUDED_SANCTIONS_MEASURES = Object.freeze([
  "Financial restrictions",
  "Import restrictions",
  "Export control",
  "Investment ban",
  "Services ban",
  "Sectoral sanctions",
  "Transportation restrictions",
]);

const includedMeasureSet = new Set(INCLUDED_SANCTIONS_MEASURES);

function uniqueStrings(values, label) {
  if (!Array.isArray(values) || values.some(value => typeof value !== "string" || value.length === 0) ||
      new Set(values).size !== values.length) {
    throw new Error(`sanctions program ${label} is invalid or duplicated`);
  }
  return [...values];
}

export function parseOpenSanctionsPrograms(document) {
  if (!document || !Array.isArray(document.data) || document.data.length === 0) {
    throw new Error("OpenSanctions program directory is unavailable");
  }
  const keys = new Set();
  return document.data.map(program => {
    if (!program || typeof program.key !== "string" || program.key.length === 0 || keys.has(program.key) ||
        typeof program.title !== "string" || program.title.length === 0 ||
        typeof program.url !== "string" || !/^https?:\/\//u.test(program.url) ||
        typeof program.status !== "string" ||
        !program.issuer || typeof program.issuer.name !== "string" ||
        (program.issuer.territory !== null && typeof program.issuer.territory !== "string")) {
      throw new Error("OpenSanctions program record is invalid or ambiguous");
    }
    keys.add(program.key);
    return {
      key: program.key,
      title: program.title,
      url: program.url,
      issuer: {
        name: program.issuer.name,
        acronym: program.issuer.acronym ?? null,
        organisation: program.issuer.organisation ?? null,
        territory: program.issuer.territory,
      },
      target_territories: uniqueStrings(program.target_territories ?? [], "target territories"),
      measures: uniqueStrings(program.measures ?? [], "measures"),
      aliases: uniqueStrings(program.aliases ?? [], "aliases"),
      status: program.status,
    };
  });
}

export function selectIncludedUsPrograms(programs) {
  if (!Array.isArray(programs)) throw new Error("sanctions programs must be an array");
  return programs.filter(program =>
    program.status === "active" &&
    program.issuer?.territory === "us" &&
    program.measures?.some(measure => includedMeasureSet.has(measure))
  );
}

export function buildSanctionsEnrichment(cyberResults, sourcePrograms) {
  if (!Array.isArray(cyberResults) || cyberResults.length === 0 || !Array.isArray(sourcePrograms)) {
    throw new Error("sanctions enrichment inputs have unexpected shapes");
  }
  const selectedPrograms = selectIncludedUsPrograms(sourcePrograms);
  const programKeys = new Set();
  for (const program of selectedPrograms) {
    if (programKeys.has(program.key)) throw new Error(`selected sanctions program is duplicated: ${program.key}`);
    programKeys.add(program.key);
  }

  const canonicalCodes = new Set();
  const usedProgramKeys = new Set();
  const results = cyberResults.map(result => {
    if (!Number.isInteger(result.index) || !/^[A-Z]{2}$/u.test(result.code ?? "") ||
        typeof result.name !== "string" || canonicalCodes.has(result.code)) {
      throw new Error("canonical country result is invalid or ambiguous");
    }
    canonicalCodes.add(result.code);
    const target = result.code.toLowerCase();
    const programIds = selectedPrograms
      .filter(program => program.target_territories.includes(target))
      .map(program => program.key)
      .sort((left, right) => left.localeCompare(right));
    for (const key of programIds) usedProgramKeys.add(key);
    return {
      index: result.index,
      code: result.code,
      name: result.name,
      program_ids: programIds,
    };
  });

  const programs = selectedPrograms
    .filter(program => usedProgramKeys.has(program.key))
    .map(program => ({
      ...program,
      relevant_measures: program.measures.filter(measure => includedMeasureSet.has(measure)),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const entriesWithPrograms = results.filter(result => result.program_ids.length > 0);
  return {
    schema: "openai-cyber-verification-country-support/us-sanctions-programs/v1",
    source: {
      name: "OpenSanctions sanctions program directory",
      distribution_url: OPENSANCTIONS_PROGRAMS_URL,
      documentation_url: OPENSANCTIONS_PROGRAMS_DOCS_URL,
      license: OPENSANCTIONS_LICENSE,
      license_url: OPENSANCTIONS_LICENSE_URL,
      issuer_territory: "us",
      status: "active",
      included_measures: INCLUDED_SANCTIONS_MEASURES,
      metadata_path: "evidence/enrichment/us-sanctions-source-metadata.json",
    },
    summary: {
      canonical_country_entries: results.length,
      source_programs: sourcePrograms.length,
      active_us_programs: sourcePrograms.filter(program =>
        program.status === "active" && program.issuer?.territory === "us").length,
      selected_active_us_programs: selectedPrograms.length,
      mapped_programs: programs.length,
      entries_with_programs: entriesWithPrograms.length,
      entries_without_programs: results.length - entriesWithPrograms.length,
      program_assignments: results.reduce((sum, result) => sum + result.program_ids.length, 0),
    },
    programs,
    results,
  };
}

export function enrichOfficialComparisonWithSanctions(comparison, sanctionsEnrichment) {
  if (!comparison || !Array.isArray(comparison.results) || !sanctionsEnrichment ||
      sanctionsEnrichment.schema !== "openai-cyber-verification-country-support/us-sanctions-programs/v1" ||
      !Array.isArray(sanctionsEnrichment.results) ||
      comparison.results.length !== sanctionsEnrichment.results.length) {
    throw new Error("official comparison and sanctions enrichment shapes do not align");
  }
  const results = comparison.results.map((result, index) => {
    const sanctions = sanctionsEnrichment.results[index];
    if (result.code !== sanctions.code || result.index !== sanctions.index) {
      throw new Error("official comparison and sanctions enrichment order does not align");
    }
    return {
      ...result,
      active_us_sanctions_program_ids: [...sanctions.program_ids],
    };
  });
  const hasPrograms = result => result.active_us_sanctions_program_ids.length > 0;
  return {
    ...comparison,
    schema: "openai-cyber-verification-country-support/official-access-comparison/v3",
    sanctions_source: {
      name: "OpenSanctions sanctions program directory",
      enrichment_path: "evidence/enrichment/us-sanctions-programs.json",
      metadata_path: "evidence/enrichment/us-sanctions-source-metadata.json",
      issuer_territory: "us",
      status: "active",
      included_measures: INCLUDED_SANCTIONS_MEASURES,
    },
    summary: {
      ...comparison.summary,
      sanctions_entries_with_programs: results.filter(hasPrograms).length,
      sanctions_program_assignments: results.reduce(
        (sum, result) => sum + result.active_us_sanctions_program_ids.length, 0),
      sanctions_chatgpt_unavailable_entries_with_programs: results.filter(result =>
        !result.official_chatgpt_supported && hasPrograms(result)).length,
      sanctions_official_supported_cyber_unsupported_entries_with_programs: results.filter(result =>
        result.official_chatgpt_supported && !result.cyber_verification_supported && hasPrograms(result)).length,
    },
    results,
  };
}

const csvCell = value => /[",\n]/u.test(String(value))
  ? `"${String(value).replaceAll('"', '""')}"`
  : String(value);

export function sanctionsEnrichmentCsv(enrichment) {
  return [
    "index,code,name,program_count,program_ids",
    ...enrichment.results.map(result => [
      result.index,
      result.code,
      csvCell(result.name),
      result.program_ids.length,
      csvCell(result.program_ids.join(";")),
    ].join(",")),
  ].join("\n") + "\n";
}
