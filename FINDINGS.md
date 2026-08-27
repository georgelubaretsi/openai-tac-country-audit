# OpenAI Cyber Verification Country Support — Findings

## Result

A fresh complete pass of the OpenAI-configured Persona government-ID selector tested all **250** enabled country and territory entries.

- **177 supported (70.8%)**
- **73 unsupported (29.2%)**
- **250 transition requests and 250 transition responses**
- **All responses returned HTTP 200**

“Unsupported” has a narrow operational meaning: the transition returned an empty government-ID class list and the widget displayed:

> Unable to verify  
> We are unable to verify identities in this country. Please select another country.

This was not an HTTP or transport block.

## Comparison with OpenAI’s ChatGPT supported-country list

The canonical map was compared with OpenAI’s official [ChatGPT Supported Countries](https://help.openai.com/en/articles/7947663-chatgpt-supported-countries) article, fetched on 2026-08-27. The official article listed 208 countries, regions, and territories.

| Official ChatGPT access list | Cyber ID support | Count |
|---|---|---:|
| Listed | Supported | 164 |
| Listed | Unsupported | 44 |
| Not listed | Supported | 13 |
| Not listed | Unsupported | 29 |

The primary gap is the **44 entries OpenAI lists for ChatGPT access but whose cyber-verification transition returned no accepted ID classes**. The complete ordered comparison is stored in:

- `evidence/comparisons/openai-chatgpt-supported-countries.json`
- `evidence/comparisons/openai-chatgpt-supported-countries.csv`

The 13 selector entries with accepted cyber ID classes but absent from the official access article were American Samoa, Anguilla, Curaçao, Gibraltar, Guam, Guernsey, Isle of Man, Jersey, Kosovo, Montserrat, Puerto Rico, Turks and Caicos Islands, and the U.S. Virgin Islands.

This comparison does not imply that those 13 locations are permitted access regions. The cyber flow exposes all 250 selector entries, and an accepted ID configuration is not evidence that OpenAI permits service access from that location. Conversely, presence on the official access list does not imply that the cyber-verification template supports identity documents from that location.

## Population enrichment

The 250 canonical selector entries were enriched with 2023 population values from [Our World in Data’s population dataset](https://ourworldindata.org/grapher/population), whose 1950–2023 country records derive from the United Nations World Population Prospects 2024 revision.

- **237 entries matched a three-letter ISO-coded source record**
- **13 entries remain `null` because the primary source does not cover them under a standard three-letter code**
- **206 of 208 entries on OpenAI’s official access list have population data**
- **176 of 177 cyber-supported entries have population data**

The uncovered entries are Åland Islands, Antarctica, Bouvet Island, British Indian Ocean Territory, Christmas Island, Cocos (Keeling) Islands, French Southern Territories, Heard Island and McDonald Islands, Kosovo, Norfolk Island, Pitcairn, South Georgia and the South Sandwich Islands, and United States Minor Outlying Islands. Missing does not mean zero.

Among official-access entries with population data, **5,663,893,485 of 6,318,876,833 people (89.63%)** are in entries that also returned accepted cyber-verification ID classes. The official-access/cyber-unsupported group accounts for **654,983,348 people across 42 populated entries**, with two additional entries excluded because their population is `null`.

These are selector-entry aggregates, not an estimate of OpenAI users or identity-verification demand. Territory populations may overlap parent-country totals, so sums across all 250 entries are not necessarily mutually exclusive. The committed source metadata records the fetch timestamp, source URLs, source payload hashes, reference year, alias method, null handling, and overlap caveat.

## Method

- Surface: the production Persona widget embedded in OpenAI’s cyber-verification page.
- Chrome was already running with CDP enabled.
- A user signed in, opened the page, clicked **Start verification**, and left the widget on its country selector before automation began.
- The selector exposed 250 enabled entries.
- Entries were exercised in their displayed order, Afghanistan through Zimbabwe.
- For each entry:
  1. select the country;
  2. wait at least three seconds;
  3. capture full-page and widget-only selected-country screenshots;
  4. press **Select**;
  5. capture the exact CDP request and response without mutation;
  6. wait for a stable result state;
  7. hold for at least one second;
  8. capture full-page and widget-only result screenshots;
  9. create a deterministic selected/result widget comparison;
  10. return to the selector and wait at least one second.

One supported country transitioned directly to its only accepted document type; countries with multiple accepted classes displayed an ID-class chooser. The classification comes from the response’s `next-step.config.idclasses`, not from OCR or screenshot interpretation.

The first corrected-media attempt was explicitly stopped after the browser window was accidentally resized. Its partial runtime artifacts were not promoted. The final committed run restarted from Afghanistan with the stabilized window geometry and completed all 250 countries without a resume.

## Evidence architecture

Exact unredacted request/response bodies and metadata remain only in ignored local runtime storage. They are not committed.

Committed requests and responses are deterministic post-capture derivatives:

- the original artifact is hashed before sanitization;
- only declared sensitive byte spans are replaced;
- bytes outside redactions remain identical;
- each sanitized artifact has its own hash;
- each artifact has a redaction sidecar containing raw and sanitized ranges, replacement, reason, and hashes;
- a fail-closed audit verifies hashes, byte correspondence, JSON/multipart validity, country alignment, and absence of secret-shaped values.

Five images were produced for each country: a full-page selected/result pair, a widget-only selected/result pair, and a deterministic side-by-side widget comparison. The committed evidence contains **1,250 screenshots**. Captured images were promoted byte-for-byte after explicit confirmation that they contain no PII; comparisons are lossless derived WebPs linked to their source pair.

## Accepted document classes

Among the 177 supported entries:

| Code | Document class | Countries offering it |
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

Every supported entry accepted a passport. Other document classes vary by country.

## Notable patterns

### Most surprising official-access cyber gaps

“Surprising” here is descriptive rather than causal. These entries stand out because of population scale, a close supported comparator, or an internally inconsistent territory configuration. The evidence does not identify why an entry lacks cyber-verification classes.

#### Direct country anomalies

- **Georgia (`GE`)** — officially available, population **3,807,494**, but no cyber-verification classes. Neighboring Türkiye supports driver license, national ID, and passport. Armenia and Azerbaijan are also gaps, suggesting a broader Caucasus configuration hole rather than a Georgia-specific decision.
- **Vietnam (`VN`)** — officially available, population **100,352,189**, but no cyber-verification classes. Thailand, Indonesia, Malaysia, and the Philippines support driver license, national ID, and passport; the Philippines also supports additional classes.
- **Democratic Republic of the Congo (`CD`)** — officially available, population **105,789,733**, but no cyber-verification classes. The Republic of the Congo supports driver license, national ID, and passport.
- **Moldova (`MD`)** — officially available, population **3,067,072**, but no cyber-verification classes. Romania supports driver license, national ID, and passport, while Ukraine supports driver license and passport.

#### Territory configuration anomalies

- **Ten French-associated entries** — French Guiana, French Polynesia, French Southern Territories, Guadeloupe, Martinique, Mayotte, New Caledonia, Réunion, Saint Barthélemy, and Saint Pierre and Miquelon are officially available but have no cyber-verification classes. France supports driver license, national ID, and passport.
- **Aruba (`AW`)** — officially available but has no cyber-verification classes. Curaçao is absent from the official access list but its cyber configuration supports driver license, national ID, and passport; the Netherlands supports the same three classes. This inversion shows that official access and cyber-verification configuration are maintained independently.

#### Large regional omissions

| Country | Code | 2023 population |
|---|---|---:|
| Uzbekistan | `UZ` | 35,652,311 |
| Kazakhstan | `KZ` | 20,330,109 |
| Cambodia | `KH` | 17,423,884 |
| Zimbabwe | `ZW` | 16,340,829 |

Kazakhstan, Kyrgyzstan, Tajikistan, Turkmenistan, and Uzbekistan form a complete Central Asian gap among officially available entries. Alongside Armenia, Azerbaijan, Georgia, Moldova, and Mongolia, this suggests a broader regional coverage or configuration boundary rather than isolated country anomalies.

The transition carries no reason field. Document coverage, OpenAI configuration, compliance policy, and fraud policy cannot be separated from this evidence.

## Availability gaps

These tables separate official ChatGPT availability from cyber-verification availability. ChatGPT availability is based on OpenAI’s official supported-country list. Cyber verification is unavailable when the observed transition returned no accepted government-ID classes.

The **broad/extensive sanctions signal** identifies current broad country restrictions or extensive sanctions spanning a government and multiple major sectors. `—` means no comparable current broad or extensive signal. This classification is contextual and does not establish why OpenAI or Persona configured an entry as unavailable.

### ChatGPT unavailable according to OpenAI’s official access list — 42 entries

These selector entries are absent from OpenAI’s official access list. Thirteen returned accepted cyber-verification classes, but widget configuration does not override the official ChatGPT access policy.

| Entry | Code | Broad/extensive sanctions signal |
|---|---|---|
| American Samoa | `AS` | — |
| Anguilla | `AI` | — |
| Antarctica | `AQ` | — |
| Belarus | `BY` | Extensive |
| Bonaire, Sint Eustatius and Saba | `BQ` | — |
| Bouvet Island | `BV` | — |
| British Indian Ocean Territory | `IO` | — |
| China | `CN` | — |
| Christmas Island | `CX` | — |
| Cocos (Keeling) Islands | `CC` | — |
| Cook Islands | `CK` | — |
| Cuba | `CU` | Broad |
| Curaçao | `CW` | — |
| Falkland Islands (Malvinas) | `FK` | — |
| Gibraltar | `GI` | — |
| Guam | `GU` | — |
| Guernsey | `GG` | — |
| Heard Island and McDonald Islands | `HM` | — |
| Hong Kong | `HK` | — |
| Iran | `IR` | Broad |
| Isle of Man | `IM` | — |
| Jersey | `JE` | — |
| Kosovo | `XK` | — |
| Macao | `MO` | — |
| Montserrat | `MS` | — |
| Niue | `NU` | — |
| Norfolk Island | `NF` | — |
| North Korea | `KP` | Broad |
| Northern Mariana Islands | `MP` | — |
| Pitcairn | `PN` | — |
| Puerto Rico | `PR` | — |
| Russian Federation | `RU` | Extensive |
| Sint Maarten (Dutch part) | `SX` | — |
| South Georgia and the South Sandwich Islands | `GS` | — |
| Syrian Arab Republic | `SY` | — |
| Tokelau | `TK` | — |
| Turks and Caicos Islands | `TC` | — |
| United States Minor Outlying Islands | `UM` | — |
| Venezuela | `VE` | Extensive |
| Virgin Islands, British | `VG` | — |
| Virgin Islands, U.S. | `VI` | — |
| Western Sahara | `EH` | — |

### ChatGPT available, but cyber verification unavailable — 44 entries

These entries appear on OpenAI’s official access list, but their observed cyber-verification transitions returned no accepted government-ID classes.

| Entry | Code | Broad/extensive sanctions signal |
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
| Myanmar | `MM` | Extensive |
| New Caledonia | `NC` | — |
| Nicaragua | `NI` | — |
| Réunion | `RE` | — |
| Saint Barthélemy | `BL` | — |
| Saint Helena, Ascension and Tristan da Cunha | `SH` | — |
| Saint Pierre and Miquelon | `PM` | — |
| Somalia | `SO` | — |
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

Prominent sanctions align with six of the 42 ChatGPT-unavailable entries and one of the 44 cyber-specific gaps. Most cyber-verification gaps, including Georgia, are not explained by a broad or extensive sanctions signal.

**Sanctions sources, checked 2026-08-27:** OFAC’s [sanctions-program index](https://ofac.treasury.gov/sanctions-programs-and-country-information) and current program information for [Belarus](https://ofac.treasury.gov/sanctions-programs-and-country-information/belarus-sanctions), [Cuba](https://ofac.treasury.gov/sanctions-programs-and-country-information/cuba-sanctions), [Iran](https://ofac.treasury.gov/sanctions-programs-and-country-information/iran-sanctions), [North Korea](https://ofac.treasury.gov/sanctions-programs-and-country-information/north-korea-sanctions), [Russia](https://ofac.treasury.gov/sanctions-programs-and-country-information/russian-harmful-foreign-activities-sanctions), [Venezuela](https://ofac.treasury.gov/sanctions-programs-and-country-information/venezuela-related-sanctions), and [Myanmar](https://ofac.treasury.gov/sanctions-programs-and-country-information/burma).

## Limitations

- One production OpenAI Persona inquiry template.
- One browser session and point in time.
- The result measures accepted government-ID classes, not whether a submitted document would pass verification.
- No identity document was uploaded and verification was not completed.
- The selector’s inclusion of a country does not imply support; rejection occurs after submission.
- OpenAI or Persona can change the configuration without notice.
- Population values use one 2023 source snapshot; 13 selector entries are not covered and remain `null`.
- Population-weighted sums may double-count territories already represented in parent-country estimates.

## Evidence inventory

- `evidence/country-support.json` — canonical ordered map and summary.
- `evidence/country-support.csv` — spreadsheet-friendly map.
- `evidence/comparisons/openai-chatgpt-supported-countries.json` — official access-list snapshot, mappings, 2×2 comparison, all 250 classifications, joined population fields, and population-weighted summaries.
- `evidence/comparisons/openai-chatgpt-supported-countries.csv` — spreadsheet-friendly official-access and population comparison.
- `evidence/enrichment/population-2023.json` — ordered population enrichment for all 250 canonical entries.
- `evidence/enrichment/population-2023.csv` — spreadsheet-friendly population enrichment.
- `evidence/enrichment/population-source-metadata.json` — source URLs, hashes, fetch time, source citation, coverage, and matching method.
- `evidence/sanitized-transitions/requests/` — post-capture-sanitized request metadata and bodies.
- `evidence/sanitized-transitions/responses/` — post-capture-sanitized response metadata and bodies.
- `evidence/sanitized-transitions/redactions/` — raw-to-sanitized byte-span manifests.
- `evidence/screenshots/countries/` — full-page selected and result screenshot pair for every country.
- `evidence/screenshots/widgets/` — widget-only selected and result screenshot pair for every country.
- `evidence/screenshots/comparisons/` — lossless selected/result widget comparison for every country.
- `evidence/video/representative/` — one 1392×1440 H.264 representative video covering all 73 unsupported transitions, plus its chapter index.
- `evidence/capture-metadata.json` — timing, counts, sanitizer version, and audit lineage.
- `evidence/manifest.json` — hashes and byte counts for every committed evidence artifact.
