import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPopulationEnrichment,
  enrichOfficialComparison,
  parseOwidPopulationCsv,
  POPULATION_YEAR,
} from "../lib/population.mjs";

const csv = `Entity,Code,Year,Population
"Congo, historical",,2023,1
Brunei,BRN,2023,458959
Kosovo,OWID_KOS,2023,1700039
Afghanistan,AFG,2023,41454761
Afghanistan,AFG,2022,40578842
`;

test("OWID parser retains only unambiguous ISO-3 records for the reference year", () => {
  assert.deepEqual(parseOwidPopulationCsv(csv), [
    { entity: "Brunei", iso3: "BRN", year: POPULATION_YEAR, population: 458959 },
    { entity: "Afghanistan", iso3: "AFG", year: POPULATION_YEAR, population: 41454761 },
  ]);
  assert.throws(() => parseOwidPopulationCsv(`${csv}Afghanistan,AFG,2023,1\n`), /ambiguous/u);
});

test("population enrichment applies reviewed aliases and preserves source gaps as null", () => {
  const enrichment = buildPopulationEnrichment([
    { index: 1, code: "AF", name: "Afghanistan" },
    { index: 2, code: "BN", name: "Brunei Darussalam" },
    { index: 3, code: "XK", name: "Kosovo" },
  ], parseOwidPopulationCsv(csv));

  assert.deepEqual(enrichment.results.map(result => [result.code, result.iso3, result.population, result.population_status]), [
    ["AF", "AFG", 41454761, "matched"],
    ["BN", "BRN", 458959, "matched"],
    ["XK", null, null, "not-covered-by-primary-source"],
  ]);
  assert.deepEqual(enrichment.summary.missing_codes, ["XK"]);
});

test("population-weighted comparison reports null exclusions and uses only covered values", () => {
  const population = buildPopulationEnrichment([
    { index: 1, code: "AF", name: "Afghanistan" },
    { index: 2, code: "BN", name: "Brunei Darussalam" },
    { index: 3, code: "XK", name: "Kosovo" },
  ], parseOwidPopulationCsv(csv));
  const comparison = enrichOfficialComparison({
    schema: "openai-cyber-verification-country-support/official-access-comparison/v1",
    summary: {},
    results: [
      { index: 1, code: "AF", official_chatgpt_supported: true, cyber_verification_supported: true, classification: "official-and-cyber-supported" },
      { index: 2, code: "BN", official_chatgpt_supported: true, cyber_verification_supported: false, classification: "official-supported-cyber-unsupported" },
      { index: 3, code: "XK", official_chatgpt_supported: true, cyber_verification_supported: true, classification: "official-and-cyber-supported" },
    ],
  }, population);

  assert.equal(comparison.schema, "openai-cyber-verification-country-support/official-access-comparison/v2");
  assert.deepEqual(comparison.summary.population_weighted.official_chatgpt_supported, {
    population: 41913720,
    country_entries_with_population: 2,
    country_entries_without_population: 1,
  });
  assert.equal(comparison.summary.population_weighted.official_supported_population_with_cyber_verification_percent, 98.9);
});
