# OpenAI Cyber Verification Country Support — Findings

## Executive summary

This report documents a complete 2026-08-27 audit of the country selector in the Persona government-ID widget configured for OpenAI’s cyber-verification flow.

| Measure | Result |
|---|---:|
| Selector entries tested | 250 |
| Cyber verification supported | 177 (70.8%) |
| Cyber verification unsupported | 73 (29.2%) |
| Entries on OpenAI’s official ChatGPT access list | 208 |
| Officially listed entries without cyber-verification support | 44 |
| Transition responses returning HTTP 200 | 250 of 250 |

The primary finding is a gap between general ChatGPT availability and cyber-verification coverage: **44 countries, regions, or territories appear on OpenAI’s official access list but returned no accepted government-ID classes in the audited cyber flow**.

Population data is available for 42 of those 44 entries. They represent **654,983,348 people** using 2023 population estimates. Across all officially listed entries with population data, **89.63% of the represented population** is in entries that also have cyber-verification support.

The observed transition data does not identify why a country lacks support. The evidence cannot distinguish document coverage, OpenAI configuration, compliance policy, fraud controls, or other operational decisions.

## Scope and definitions

The unit of analysis is a selector entry, not necessarily a sovereign country. The 250 entries include countries, regions, and territories exposed by the production Persona widget.

- **Cyber verification supported** means the transition response contained at least one accepted government-ID class in `next-step.config.idclasses`.
- **Cyber verification unsupported** means the transition returned an empty ID-class list and the widget displayed:  
  > Unable to verify  
  > We are unable to verify identities in this country. Please select another country.
- **Official ChatGPT availability** means the entry appeared in OpenAI’s published [ChatGPT Supported Countries](https://help.openai.com/en/articles/7947663-chatgpt-supported-countries) article when fetched on 2026-08-27.
- **Matched sanctions program** means an active U.S.-issued OpenSanctions program targeted the entry and included at least one of the defined financial, import, export, investment, services, sectoral, or transportation measures.

Cyber-verification configuration is not evidence that OpenAI permits ChatGPT access from a location. Conversely, presence on OpenAI’s official access list is not evidence that the audited cyber-verification template accepts that location’s identity documents.

## Methodology

The audit exercised the production Persona widget embedded in OpenAI’s cyber-verification page. Before automation began, a user signed in, opened the flow, clicked **Start verification**, and left the widget on its government-ID country selector. Chrome was already running with CDP enabled.

The selector exposed 250 enabled entries, ordered from Afghanistan through Zimbabwe. For each entry, the recorder:

1. selected the entry;
2. waited at least three seconds;
3. captured full-page and widget-only selected-country screenshots;
4. pressed **Select**;
5. captured the exact CDP transition request and response without mutation;
6. waited for a stable supported or unsupported state;
7. held the result for at least one second;
8. captured full-page and widget-only result screenshots;
9. created a deterministic selected/result widget comparison;
10. returned to the selector and waited at least one second.

Classification used the transition response, not OCR or screenshot interpretation. Entries with multiple accepted classes displayed an ID-class chooser; one supported entry transitioned directly to its only accepted document type.

Only the final complete 250-entry run was promoted to committed evidence. Incomplete runtime attempts remained in ignored local storage.

## Evidence integrity

Exact unredacted request and response bodies remain only in ignored local runtime storage. They are not committed.

Committed transition artifacts are deterministic post-capture derivatives:

- each raw artifact is hashed before sanitization;
- only declared sensitive byte spans are replaced;
- bytes outside declared redactions remain identical;
- each sanitized artifact receives a separate hash;
- each artifact has a redaction sidecar recording ranges, replacements, reasons, and hashes;
- a fail-closed audit verifies hashes, byte correspondence, JSON or multipart validity, country alignment, and absence of secret-shaped values.

Five images were produced for each entry: full-page selected and result screenshots, widget-only selected and result screenshots, and a lossless side-by-side widget comparison. The committed evidence contains **1,250 screenshots**. Captured images were promoted byte-for-byte after confirmation that they contain no PII.

The representative video contains all 73 unsupported transitions and is accompanied by a chapter index.

## Results

### Cyber-verification coverage

Of 250 selector entries, **177 returned accepted ID classes** and **73 returned none**. Every transition response returned HTTP 200, so unsupported results were application-level configuration outcomes rather than HTTP or transport failures.

Every supported entry accepted a passport. Other document classes varied:

| Code | Document class | Entries offering it |
|---|---|---:|
| `pp` | Passport | 177 |
| `dl` | Driver License | 116 |
| `id` | National or provincial ID | 105 |
| `vid` | Voter ID | 8 |
| `wp` | Work Permit | 3 |
| `pr` | Permanent Resident Card | 3 |
| `pan` | PAN Card | 1 |
| `sid` | Seafarer ID | 1 |
| `rp` | Residency Permit | 1 |

### Alignment with OpenAI’s official access list

OpenAI’s official article listed 208 countries, regions, and territories. Comparing that list with the cyber-verification results produced four groups:

| Official ChatGPT access list | Cyber verification | Entries |
|---|---|---:|
| Listed | Supported | 164 |
| Listed | Unsupported | 44 |
| Not listed | Supported | 13 |
| Not listed | Unsupported | 29 |

The 44 listed-but-unsupported entries are the primary operational gap.

The 13 entries with cyber-verification support but no official ChatGPT listing are American Samoa, Anguilla, Curaçao, Gibraltar, Guam, Guernsey, Isle of Man, Jersey, Kosovo, Montserrat, Puerto Rico, Turks and Caicos Islands, and the U.S. Virgin Islands. Their cyber configuration does not establish that ChatGPT access is permitted from those locations.

The complete comparison is stored in:

- `evidence/comparisons/openai-chatgpt-supported-countries.json`
- `evidence/comparisons/openai-chatgpt-supported-countries.csv`

### Population-weighted view

The canonical entries were enriched with 2023 population values from [Our World in Data’s population dataset](https://ourworldindata.org/grapher/population), whose 1950–2023 country records derive from the United Nations World Population Prospects 2024 revision.

| Population coverage | Entries |
|---|---:|
| Matched to an ISO-coded source record | 237 |
| Not covered by the primary source | 13 |
| Officially listed entries with population data | 206 of 208 |
| Cyber-supported entries with population data | 176 of 177 |

The 13 uncovered entries are Åland Islands, Antarctica, Bouvet Island, British Indian Ocean Territory, Christmas Island, Cocos (Keeling) Islands, French Southern Territories, Heard Island and McDonald Islands, Kosovo, Norfolk Island, Pitcairn, South Georgia and the South Sandwich Islands, and United States Minor Outlying Islands. Missing population remains `null`; it is not interpreted as zero.

Among officially listed entries with population data:

- **6,318,876,833** people are represented in total;
- **5,663,893,485** are represented in entries with cyber-verification support;
- **654,983,348** are represented in 42 listed entries without cyber-verification support;
- two additional listed-but-unsupported entries have `null` population;
- the resulting population-weighted cyber-verification coverage is **89.63%**.

These are selector-entry aggregates, not estimates of OpenAI users or verification demand. Territory populations may overlap parent-country totals, so totals across all 250 entries are not necessarily mutually exclusive.

## High-salience coverage patterns

The following patterns describe differences in configuration; they do not establish cause.

### Country-level contrasts

- **Georgia (`GE`)** — listed for ChatGPT access, population **3,807,494**, but no cyber-verification classes. Neighboring Türkiye supports driver license, national ID, and passport. Armenia and Azerbaijan are also gaps, indicating a broader Caucasus pattern rather than an isolated Georgian result.
- **Vietnam (`VN`)** — listed for access, population **100,352,189**, but no cyber-verification classes. Thailand, Indonesia, Malaysia, and the Philippines support driver license, national ID, and passport; the Philippines also supports additional classes.
- **Democratic Republic of the Congo (`CD`)** — listed for access, population **105,789,733**, but no cyber-verification classes. The Republic of the Congo supports driver license, national ID, and passport.
- **Moldova (`MD`)** — listed for access, population **3,067,072**, but no cyber-verification classes. Romania supports driver license, national ID, and passport; Ukraine supports driver license and passport.

### Territory-level contrasts

- Ten French-associated entries—French Guiana, French Polynesia, French Southern Territories, Guadeloupe, Martinique, Mayotte, New Caledonia, Réunion, Saint Barthélemy, and Saint Pierre and Miquelon—are listed for ChatGPT access but have no cyber-verification classes. France supports driver license, national ID, and passport.
- Aruba is listed for ChatGPT access but has no cyber-verification classes. Curaçao is absent from the official access list but its cyber configuration supports driver license, national ID, and passport; the Netherlands supports the same three classes.

These results are consistent with independent per-entry configuration rather than automatic inheritance from a parent state.

### Regional concentration

Kazakhstan, Kyrgyzstan, Tajikistan, Turkmenistan, and Uzbekistan form a complete Central Asian gap among officially listed entries. Armenia, Azerbaijan, Georgia, Moldova, and Mongolia extend the broader regional concentration.

| Selected gap | Code | 2023 population |
|---|---|---:|
| Uzbekistan | `UZ` | 35,652,311 |
| Kazakhstan | `KZ` | 20,330,109 |
| Cambodia | `KH` | 17,423,884 |
| Zimbabwe | `ZW` | 16,340,829 |

## Country availability lists

The tables below focus on the two categories where ChatGPT or cyber verification is unavailable. They omit the 164 entries that are both officially listed and cyber supported.

The sanctions-program column is contextual. It lists active U.S.-issued OpenSanctions programs that target the entry and contain at least one included measure. Program IDs link to the authoritative source recorded by OpenSanctions. `—` means no program matched the source and measure filter; it is not a legal conclusion.

### Not on OpenAI’s official ChatGPT access list — 42 entries

Thirteen entries in this group nevertheless expose accepted cyber-verification classes. Cyber configuration does not override the official access list.

| Entry | Code | Matched active U.S. sanctions programs |
|---|---|---|
| American Samoa | `AS` | — |
| Anguilla | `AI` | — |
| Antarctica | `AQ` | — |
| Belarus | `BY` | — |
| Bonaire, Sint Eustatius and Saba | `BQ` | — |
| Bouvet Island | `BV` | — |
| British Indian Ocean Territory | `IO` | — |
| China | `CN` | [`US-NS-CMIC`](https://ofac.treasury.gov/sanctions-programs-and-country-information/chinese-military-companies-sanctions); [`US-UFLPA`](https://www.dhs.gov/uflpa) |
| Christmas Island | `CX` | — |
| Cocos (Keeling) Islands | `CC` | — |
| Cook Islands | `CK` | — |
| Cuba | `CU` | [`US-CUBA`](https://ofac.treasury.gov/sanctions-programs-and-country-information/cuba-sanctions); [`US-DOS-CU-PAL`](https://www.state.gov/cuba-sanctions/cuba-prohibited-accommodations-list); [`US-DOS-CU-REA`](https://www.state.gov/division-for-counter-threat-finance-and-sanctions/cuba-restricted-list) |
| Curaçao | `CW` | — |
| Falkland Islands (Malvinas) | `FK` | — |
| Gibraltar | `GI` | — |
| Guam | `GU` | — |
| Guernsey | `GG` | — |
| Heard Island and McDonald Islands | `HM` | — |
| Hong Kong | `HK` | — |
| Iran | `IR` | [`US-FSE`](https://ofac.treasury.gov/other-ofac-sanctions-lists); [`US-IRAN`](https://ofac.treasury.gov/sanctions-programs-and-country-information/iran-sanctions) |
| Isle of Man | `IM` | — |
| Jersey | `JE` | — |
| Kosovo | `XK` | — |
| Macao | `MO` | — |
| Montserrat | `MS` | — |
| Niue | `NU` | — |
| Norfolk Island | `NF` | — |
| North Korea | `KP` | [`US-NK`](https://ofac.treasury.gov/sanctions-programs-and-country-information/north-korea-sanctions) |
| Northern Mariana Islands | `MP` | — |
| Pitcairn | `PN` | — |
| Puerto Rico | `PR` | — |
| Russian Federation | `RU` | [`US-RUSHAR`](https://ofac.treasury.gov/sanctions-programs-and-country-information/russian-harmful-foreign-activities-sanctions); [`US-SSI`](https://ofac.treasury.gov/other-ofac-sanctions-lists); [`US-UKRRUS-REL`](https://ofac.treasury.gov/sanctions-programs-and-country-information/ukraine-russia-related-sanctions) |
| Sint Maarten (Dutch part) | `SX` | — |
| South Georgia and the South Sandwich Islands | `GS` | — |
| Syrian Arab Republic | `SY` | [`US-FSE`](https://ofac.treasury.gov/other-ofac-sanctions-lists); [`US-SYR-REL`](https://ofac.treasury.gov/sanctions-programs-and-country-information/paarss) |
| Tokelau | `TK` | — |
| Turks and Caicos Islands | `TC` | — |
| United States Minor Outlying Islands | `UM` | — |
| Venezuela | `VE` | [`US-VEN`](https://ofac.treasury.gov/sanctions-programs-and-country-information/venezuela-related-sanctions) |
| Virgin Islands, British | `VG` | — |
| Virgin Islands, U.S. | `VI` | — |
| Western Sahara | `EH` | — |

### Listed for ChatGPT access but unsupported by cyber verification — 44 entries

| Entry | Code | Matched active U.S. sanctions programs |
|---|---|---|
| Afghanistan | `AF` | — |
| Åland Islands | `AX` | — |
| Armenia | `AM` | — |
| Aruba | `AW` | — |
| Azerbaijan | `AZ` | — |
| Cambodia | `KH` | — |
| Central African Republic | `CF` | — |
| Congo, The Democratic Republic of the | `CD` | — |
| Eritrea | `ER` | — |
| French Guiana | `GF` | — |
| French Polynesia | `PF` | — |
| French Southern Territories | `TF` | — |
| Georgia | `GE` | — |
| Guadeloupe | `GP` | — |
| Haiti | `HT` | — |
| Holy See (Vatican City State) | `VA` | — |
| Iraq | `IQ` | — |
| Kazakhstan | `KZ` | — |
| Kyrgyzstan | `KG` | — |
| Lao People's Democratic Republic | `LA` | — |
| Lebanon | `LB` | — |
| Libya | `LY` | — |
| Martinique | `MQ` | — |
| Mayotte | `YT` | — |
| Moldova | `MD` | — |
| Mongolia | `MN` | — |
| Myanmar | `MM` | [`US-BURMA`](https://ofac.treasury.gov/sanctions-programs-and-country-information/burma) |
| New Caledonia | `NC` | — |
| Nicaragua | `NI` | — |
| Réunion | `RE` | — |
| Saint Barthélemy | `BL` | — |
| Saint Helena, Ascension and Tristan da Cunha | `SH` | — |
| Saint Pierre and Miquelon | `PM` | — |
| Somalia | `SO` | [`US-SOMALIA`](https://ofac.treasury.gov/sanctions-programs-and-country-information/somalia-sanctions) |
| South Sudan | `SS` | — |
| Sudan | `SD` | — |
| Svalbard and Jan Mayen | `SJ` | — |
| Tajikistan | `TJ` | — |
| Turkmenistan | `TM` | — |
| Uzbekistan | `UZ` | — |
| Vietnam | `VN` | — |
| Wallis and Futuna | `WF` | — |
| Yemen | `YE` | — |
| Zimbabwe | `ZW` | — |

Seven of the 42 entries absent from OpenAI’s official list and two of the 44 cyber-verification gaps have at least one matched program under this definition. Georgia has no matched program.

**Sanctions source, fetched 2026-08-27:** [OpenSanctions sanctions program directory](https://data.opensanctions.org/meta/programs.json), filtered to active U.S.-issued programs and the defined measures. Contains data from [OpenSanctions](https://www.opensanctions.org/docs/programs/) under [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/). The committed source metadata records the exact fetch timestamp, source hash, filter, and coverage.

## Interpretation

The observed results demonstrate country-code-specific configuration differences in one production Persona template. They do not identify the policy or operational cause of those differences.

In particular:

- an empty ID-class list does not mean that every identity document from the entry is technically unreadable;
- an accepted ID-class list does not mean a submitted document would pass verification;
- sanctions-program matches provide context but do not establish legal applicability to every resident or explain OpenAI’s configuration;
- population-weighted totals describe represented populations, not affected users or demand;
- territory and parent-country configurations cannot be assumed to inherit from one another.

## Limitations

- One production OpenAI Persona inquiry template was tested.
- The audit represents one browser session and one point in time.
- No identity document was uploaded and identity verification was not completed.
- The selector’s inclusion of an entry does not imply support; unsupported results occur after submission of the selector choice.
- OpenAI or Persona may change the configuration without notice.
- Population values use one 2023 source snapshot; 13 entries remain `null`.
- Territory population totals may overlap parent-country estimates.
- Sanctions mappings use one OpenSanctions program-directory snapshot and its curated target-territory and measure taxonomy.

## Evidence inventory

- `evidence/country-support.json` — canonical ordered map and summary.
- `evidence/country-support.csv` — spreadsheet-friendly map.
- `evidence/comparisons/openai-chatgpt-supported-countries.json` — official access-list snapshot, mappings, 2×2 comparison, all 250 classifications, joined population fields, sanctions program IDs, and derived summaries.
- `evidence/comparisons/openai-chatgpt-supported-countries.csv` — spreadsheet-friendly official-access, population, and sanctions-program comparison.
- `evidence/enrichment/population-2023.json` — ordered population enrichment for all 250 canonical entries.
- `evidence/enrichment/population-2023.csv` — spreadsheet-friendly population enrichment.
- `evidence/enrichment/population-source-metadata.json` — population source URLs, hashes, fetch time, citation, coverage, and matching method.
- `evidence/enrichment/us-sanctions-programs.json` — ordered active U.S. sanctions-program mapping for all 250 canonical entries.
- `evidence/enrichment/us-sanctions-programs.csv` — spreadsheet-friendly sanctions-program mapping.
- `evidence/enrichment/us-sanctions-source-metadata.json` — OpenSanctions attribution, license, source hash, fetch time, filter, and coverage.
- `evidence/sanitized-transitions/requests/` — post-capture-sanitized request metadata and bodies.
- `evidence/sanitized-transitions/responses/` — post-capture-sanitized response metadata and bodies.
- `evidence/sanitized-transitions/redactions/` — raw-to-sanitized byte-span manifests.
- `evidence/screenshots/countries/` — full-page selected and result screenshot pair for every entry.
- `evidence/screenshots/widgets/` — widget-only selected and result screenshot pair for every entry.
- `evidence/screenshots/comparisons/` — lossless selected/result widget comparison for every entry.
- `evidence/video/representative/` — one 1392×1440 H.264 representative video covering all 73 unsupported transitions, plus its chapter index.
- `evidence/capture-metadata.json` — timing, counts, sanitizer version, and audit lineage.
- `evidence/manifest.json` — hashes and byte counts for every committed evidence artifact.
