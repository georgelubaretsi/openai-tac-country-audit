const HEADING = /<h2[^>]*>\s*Supported countries &amp; regions on web and mobile\s*<\/h2>/iu;
const END_MARKER = "Was this article helpful";

export const OFFICIAL_SOURCE_URL = "https://help.openai.com/en/articles/7947663-chatgpt-supported-countries";

export const OFFICIAL_NAME_ALIASES = Object.freeze({
  "Brunei": "BN",
  "Congo (Brazzaville)": "CG",
  "Congo (DRC)": "CD",
  "Czechia (Czech Republic)": "CZ",
  "Eswatini (Swaziland)": "SZ",
  "Holy See (Vatican City)": "VA",
  "Laos": "LA",
  "Micronesia": "FM",
  "Palestine": "PS",
  "Saint Helena": "SH",
  "Timor-Leste (East Timor)": "TL",
  "Turkey": "TR",
  "Ukraine (with certain exceptions)": "UA",
  "United States of America": "US",
});

function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&nbsp;", " ");
}

export function normalizeCountryName(value) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll("&", "and")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

export function parseOfficialCountryNames(html) {
  if (typeof html !== "string" || html.length < 1_000) throw new Error("official source HTML is unavailable");
  const heading = HEADING.exec(html);
  if (!heading) throw new Error("official supported-country heading was not found");
  const end = html.indexOf(END_MARKER, heading.index + heading[0].length);
  if (end < 0) throw new Error("official supported-country section end was not found");
  const section = html.slice(heading.index + heading[0].length, end);
  const names = [...section.matchAll(/<li[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>\s*<\/li>/giu)]
    .map(match => decodeEntities(match[1].replace(/<[^>]+>/gu, "")).replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  if (names.length < 150 || names.length > 250 || new Set(names).size !== names.length) {
    throw new Error("official supported-country list has an unexpected count or duplicates");
  }
  return names;
}

export function compareCountrySupport(officialNames, cyberResults) {
  if (!Array.isArray(officialNames) || !Array.isArray(cyberResults) || cyberResults.length !== 250) {
    throw new Error("comparison inputs have unexpected shapes");
  }
  const byNormalizedName = new Map();
  const byCode = new Map();
  for (const result of cyberResults) {
    if (!/^[A-Z]{2}$/u.test(result.code ?? "") || typeof result.name !== "string" || typeof result.supported !== "boolean") {
      throw new Error("canonical cyber result is invalid");
    }
    const normalized = normalizeCountryName(result.name);
    if (byNormalizedName.has(normalized) || byCode.has(result.code)) throw new Error("canonical cyber results are ambiguous");
    byNormalizedName.set(normalized, result);
    byCode.set(result.code, result);
  }
  const sourceByCode = new Map();
  for (const name of officialNames) {
    const aliasCode = OFFICIAL_NAME_ALIASES[name];
    const result = aliasCode ? byCode.get(aliasCode) : byNormalizedName.get(normalizeCountryName(name));
    if (!result) throw new Error(`official country name is unmapped: ${name}`);
    if (sourceByCode.has(result.code)) throw new Error(`official country code is duplicated: ${result.code}`);
    sourceByCode.set(result.code, name);
  }
  const results = cyberResults.map(result => {
    const officialSupported = sourceByCode.has(result.code);
    const classification = officialSupported
      ? result.supported ? "official-and-cyber-supported" : "official-supported-cyber-unsupported"
      : result.supported ? "cyber-supported-not-official" : "neither-supported";
    return {
      index: result.index,
      code: result.code,
      name: result.name,
      official_source_name: sourceByCode.get(result.code) ?? null,
      official_chatgpt_supported: officialSupported,
      cyber_verification_supported: result.supported,
      classification,
    };
  });
  const count = classification => results.filter(result => result.classification === classification).length;
  return {
    official_entries: [...sourceByCode.entries()].map(([code, source_name]) => ({ code, source_name })),
    summary: {
      official_chatgpt_supported: sourceByCode.size,
      cyber_verification_supported: results.filter(result => result.cyber_verification_supported).length,
      official_and_cyber_supported: count("official-and-cyber-supported"),
      official_supported_cyber_unsupported: count("official-supported-cyber-unsupported"),
      cyber_supported_not_official: count("cyber-supported-not-official"),
      neither_supported: count("neither-supported"),
    },
    results,
  };
}
