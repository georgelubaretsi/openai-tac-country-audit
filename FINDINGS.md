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

### Large-country and regional gaps

Several unsupported entries are surprising if interpreted only as document-recognition coverage:

- China and Hong Kong are unsupported, while Taiwan supports driver license, national ID, and passport.
- Vietnam and Cambodia are unsupported, while Thailand, Indonesia, Malaysia, and the Philippines support several document classes.
- Armenia, Azerbaijan, Georgia, Kazakhstan, Kyrgyzstan, Moldova, Mongolia, and Uzbekistan form a conspicuous post-Soviet/Central Asian cluster.
- Venezuela is unsupported while Brazil, Colombia, Ecuador, and Peru are supported.
- Democratic Republic of the Congo is unsupported while the Republic of the Congo supports driver license, national ID, and passport.

The transition carries no reason field. Document coverage, OpenAI configuration, compliance policy, and fraud policy cannot be separated from this evidence.

### Territory support is not inherited from a parent state

- France is supported, while French Guiana, French Polynesia, Guadeloupe, Martinique, Mayotte, Réunion, Saint Barthélemy, and Saint Pierre and Miquelon are unsupported.
- Netherlands is supported; Curaçao is supported; Aruba, Bonaire/Sint Eustatius/Saba, and Sint Maarten are unsupported.
- United States is supported; American Samoa, Guam, Puerto Rico, and the U.S. Virgin Islands are supported; Northern Mariana Islands and U.S. Minor Outlying Islands are unsupported.
- United Kingdom is supported; Bermuda, Cayman Islands, Gibraltar, Guernsey, Isle of Man, Jersey, and Turks and Caicos are supported; British Virgin Islands and Falkland Islands are unsupported.

This is consistent with per-country-code document configuration rather than parent-country inheritance.

## Unsupported entries

1. Afghanistan (`AF`)
2. Åland Islands (`AX`)
3. Antarctica (`AQ`)
4. Armenia (`AM`)
5. Aruba (`AW`)
6. Azerbaijan (`AZ`)
7. Belarus (`BY`)
8. Bonaire, Sint Eustatius and Saba (`BQ`)
9. Bouvet Island (`BV`)
10. British Indian Ocean Territory (`IO`)
11. Cambodia (`KH`)
12. Central African Republic (`CF`)
13. China (`CN`)
14. Christmas Island (`CX`)
15. Cocos (Keeling) Islands (`CC`)
16. Congo, The Democratic Republic of the (`CD`)
17. Cook Islands (`CK`)
18. Cuba (`CU`)
19. Eritrea (`ER`)
20. Falkland Islands (Malvinas) (`FK`)
21. French Guiana (`GF`)
22. French Polynesia (`PF`)
23. French Southern Territories (`TF`)
24. Georgia (`GE`)
25. Guadeloupe (`GP`)
26. Haiti (`HT`)
27. Heard Island and McDonald Islands (`HM`)
28. Holy See (Vatican City State) (`VA`)
29. Hong Kong (`HK`)
30. Iran (`IR`)
31. Iraq (`IQ`)
32. Kazakhstan (`KZ`)
33. Kyrgyzstan (`KG`)
34. Lao People's Democratic Republic (`LA`)
35. Lebanon (`LB`)
36. Libya (`LY`)
37. Macao (`MO`)
38. Martinique (`MQ`)
39. Mayotte (`YT`)
40. Moldova (`MD`)
41. Mongolia (`MN`)
42. Myanmar (`MM`)
43. New Caledonia (`NC`)
44. Nicaragua (`NI`)
45. Niue (`NU`)
46. Norfolk Island (`NF`)
47. North Korea (`KP`)
48. Northern Mariana Islands (`MP`)
49. Pitcairn (`PN`)
50. Réunion (`RE`)
51. Russian Federation (`RU`)
52. Saint Barthélemy (`BL`)
53. Saint Helena, Ascension and Tristan da Cunha (`SH`)
54. Saint Pierre and Miquelon (`PM`)
55. Sint Maarten (Dutch part) (`SX`)
56. Somalia (`SO`)
57. South Georgia and the South Sandwich Islands (`GS`)
58. South Sudan (`SS`)
59. Sudan (`SD`)
60. Svalbard and Jan Mayen (`SJ`)
61. Syrian Arab Republic (`SY`)
62. Tajikistan (`TJ`)
63. Tokelau (`TK`)
64. Turkmenistan (`TM`)
65. United States Minor Outlying Islands (`UM`)
66. Uzbekistan (`UZ`)
67. Venezuela (`VE`)
68. Vietnam (`VN`)
69. Virgin Islands, British (`VG`)
70. Wallis and Futuna (`WF`)
71. Western Sahara (`EH`)
72. Yemen (`YE`)
73. Zimbabwe (`ZW`)

## Limitations

- One production OpenAI Persona inquiry template.
- One browser session and point in time.
- The result measures accepted government-ID classes, not whether a submitted document would pass verification.
- No identity document was uploaded and verification was not completed.
- The selector’s inclusion of a country does not imply support; rejection occurs after submission.
- OpenAI or Persona can change the configuration without notice.

## Evidence inventory

- `evidence/country-support.json` — canonical ordered map and summary.
- `evidence/country-support.csv` — spreadsheet-friendly map.
- `evidence/sanitized-transitions/requests/` — post-capture-sanitized request metadata and bodies.
- `evidence/sanitized-transitions/responses/` — post-capture-sanitized response metadata and bodies.
- `evidence/sanitized-transitions/redactions/` — raw-to-sanitized byte-span manifests.
- `evidence/screenshots/countries/` — full-page selected and result screenshot pair for every country.
- `evidence/screenshots/widgets/` — widget-only selected and result screenshot pair for every country.
- `evidence/screenshots/comparisons/` — lossless selected/result widget comparison for every country.
- `evidence/video/representative/` — one 1392×1440 H.264 representative video covering all 73 unsupported transitions, plus its chapter index.
- `evidence/capture-metadata.json` — timing, counts, sanitizer version, and audit lineage.
- `evidence/manifest.json` — hashes and byte counts for every committed evidence artifact.
