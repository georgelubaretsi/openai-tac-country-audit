import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSanctionsEnrichment,
  enrichOfficialComparisonWithSanctions,
  parseOpenSanctionsPrograms,
  sanctionsEnrichmentCsv,
} from "../lib/sanctions-programs.mjs";

const source = {
  data: [
    {
      key: "US-CN-INCLUDED",
      title: "China included program",
      url: "https://example.test/us-cn-included",
      issuer: { name: "United States", acronym: "US", organisation: null, territory: "us" },
      target_territories: ["cn"],
      measures: ["Investment ban", "Financial restrictions"],
      aliases: ["EO TEST"],
      status: "active",
    },
    {
      key: "US-BY-ASSET",
      title: "Belarus asset program",
      url: "https://example.test/us-by-asset",
      issuer: { name: "United States", acronym: "US", organisation: null, territory: "us" },
      target_territories: ["by"],
      measures: ["Asset freeze"],
      aliases: [],
      status: "active",
    },
    {
      key: "US-CN-INACTIVE",
      title: "Inactive China program",
      url: "https://example.test/us-cn-inactive",
      issuer: { name: "United States", acronym: "US", organisation: null, territory: "us" },
      target_territories: ["cn"],
      measures: ["Services ban"],
      aliases: [],
      status: "inactive",
    },
    {
      key: "AU-GE-INCLUDED",
      title: "Non-US Georgia included program",
      url: "https://example.test/au-ge-included",
      issuer: { name: "Australia", acronym: "AU", organisation: null, territory: "au" },
      target_territories: ["ge"],
      measures: ["Export control"],
      aliases: [],
      status: "active",
    },
  ],
};

const countries = [
  { index: 1, code: "CN", name: "China" },
  { index: 2, code: "GE", name: "Georgia" },
  { index: 3, code: "BY", name: "Belarus" },
];

test("sanctions enrichment selects active US programs with included measures", () => {
  const programs = parseOpenSanctionsPrograms(source);
  const enrichment = buildSanctionsEnrichment(countries, programs);

  assert.deepEqual(enrichment.results.map(result => [result.code, result.program_ids]), [
    ["CN", ["US-CN-INCLUDED"]],
    ["GE", []],
    ["BY", []],
  ]);
  assert.deepEqual(enrichment.programs.map(program => program.key), ["US-CN-INCLUDED"]);
  assert.equal(enrichment.summary.active_us_programs, 2);
  assert.equal(enrichment.summary.selected_active_us_programs, 1);
  assert.match(sanctionsEnrichmentCsv(enrichment), /^index,code,name,program_count,program_ids\n1,CN,China,1,US-CN-INCLUDED$/mu);
});

test("sanctions parser rejects duplicate program keys", () => {
  assert.throws(() => parseOpenSanctionsPrograms({ data: [source.data[0], source.data[0]] }), /ambiguous/u);
});

test("sanctions enrichment joins official comparison without changing availability fields", () => {
  const enrichment = buildSanctionsEnrichment(countries, parseOpenSanctionsPrograms(source));
  const comparison = enrichOfficialComparisonWithSanctions({
    schema: "openai-cyber-verification-country-support/official-access-comparison/v2",
    summary: {},
    results: [
      { index: 1, code: "CN", official_chatgpt_supported: false, cyber_verification_supported: false },
      { index: 2, code: "GE", official_chatgpt_supported: true, cyber_verification_supported: false },
      { index: 3, code: "BY", official_chatgpt_supported: false, cyber_verification_supported: false },
    ],
  }, enrichment);

  assert.equal(comparison.schema, "openai-cyber-verification-country-support/official-access-comparison/v3");
  assert.deepEqual(comparison.results[0].active_us_sanctions_program_ids, ["US-CN-INCLUDED"]);
  assert.equal(comparison.results[1].cyber_verification_supported, false);
  assert.equal(comparison.summary.sanctions_entries_with_programs, 1);
  assert.equal(comparison.summary.sanctions_chatgpt_unavailable_entries_with_programs, 1);
  assert.equal(comparison.summary.sanctions_official_supported_cyber_unsupported_entries_with_programs, 0);
});
