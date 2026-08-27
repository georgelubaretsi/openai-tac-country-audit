import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compareCountrySupport,
  OFFICIAL_NAME_ALIASES,
  parseOfficialCountryNames,
} from "../lib/official-country-support.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const countryMap = JSON.parse(await readFile(resolve(repoRoot, "evidence", "country-support.json"), "utf8"));
const aliasByCode = new Map(Object.entries(OFFICIAL_NAME_ALIASES).map(([name, code]) => [code, name]));

const names = countryMap.results.map(result => aliasByCode.get(result.code) ?? result.name);
const html = `<html><h2>Supported countries &amp; regions on web and mobile</h2><ul>${names
  .map(name => `<li><p>${name.replaceAll("&", "&amp;")}</p></li>`)
  .join("")}</ul><div>Was this article helpful</div></html>`;

test("official page parser extracts the bounded list and aliases map without ambiguity", () => {
  const parsed = parseOfficialCountryNames(html);
  assert.equal(parsed.length, 250);
  const comparison = compareCountrySupport(parsed, countryMap.results);
  assert.equal(comparison.summary.official_chatgpt_supported, 250);
  assert.equal(comparison.results.length, 250);
  assert.equal(new Set(comparison.official_entries.map(entry => entry.code)).size, 250);
});

test("official page parser fails closed on a truncated list", () => {
  assert.throws(() => parseOfficialCountryNames(
    "<html><h2>Supported countries &amp; regions on web and mobile</h2><ul><li><p>Albania</p></li></ul>Was this article helpful</html>"
  ));
});
