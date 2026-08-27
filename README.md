# OpenAI Cyber Verification Country Support

A reproducible audit of country and government-ID support in the Persona widget configured for OpenAI’s cyber-verification flow.

This repository records a complete selector sweep, preserves exact raw Persona transition exchanges locally, produces byte-span-sanitized request/response evidence for Git, captures full-page and widget-only selected/result screenshots plus a side-by-side widget comparison per country, stores one representative video of unsupported-country transitions, and enriches the canonical selector map with a population snapshot.

## Privacy boundary

```text
runtime/     exact raw requests/responses and unreviewed media; local and gitignored
evidence/    sanitized, audited, integrity-checked artifacts; committed
```

The recorder preserves selected transition traffic exactly. It writes CDP request/response metadata and bodies under `runtime/raw/<run-id>/` with private permissions. Sanitization writes separate deterministic artifacts by patching only declared sensitive byte spans and recording raw-to-sanitized lineage.

`runtime/` is ignored by Git. Repository checks reject any staged runtime path or raw-capture artifact.

## Requirements

- Node.js 22 or newer
- Chrome launched with a CDP remote-debugging port
- `ffmpeg` and `ffprobe` for representative video
- `curl` as a fallback transport for the OpenAI Help Center comparison

The Node.js scripts use only built-in modules.

## Browser preparation

Browser navigation, sign-in, and verification startup are manual preparation steps.

1. Launch Chrome with CDP enabled and a dedicated profile.
2. Sign in manually.
3. Open OpenAI’s cyber-verification page.
4. Click **Start verification** manually.
5. Leave the Persona widget open on **What country is your government ID from?**

The live scripts fail unless exactly one ChatGPT `/cyber` page, one Persona widget iframe, and the expected country selector are present.

## Workflow

### 1. Capture all transitions and screenshot pairs

```sh
npm run capture
```

For every selector entry, the recorder:

1. selects the country;
2. waits at least three seconds;
3. captures full-page and widget-only selected-country screenshots;
4. presses **Select**;
5. captures the exact transition request and response;
6. waits for a stable supported or unsupported result;
7. captures full-page and widget-only result screenshots;
8. creates a deterministic selected/result widget comparison;
9. waits at least one second and returns to the selector.

Raw output is written under `runtime/raw/<run-id>/`; screenshots are written under `runtime/media-raw/<run-id>/screenshots/`.

If a run is interrupted or fails after recording some countries, return the widget to the country selector and resume without overwriting completed raw artifacts:

```sh
npm run capture -- --run-id <run-id> --resume
```

### 2. Post-sanitize the raw capture

```sh
npm run sanitize -- <run-id>
```

Sanitized output is written under `runtime/sanitized-staging/<run-id>/`, leaving raw input byte-for-byte unchanged.

### 3. Audit the sanitized output

```sh
npm run audit -- <run-id>
```

The audit fails closed on unexplained byte changes, undeclared identifiers, secret-shaped values, malformed JSON/multipart, inconsistent classifications, missing transitions, or raw artifacts under `evidence/`.

### 4. Promote audited transitions and screenshots

```sh
npm run promote -- <run-id> --confirm-screenshots-pii-free
```

Promotion refuses to overwrite a non-empty evidence directory and requires a passing audit report.

### 5. Record unsupported-country transitions

After deriving the canonical map:

```sh
npm run video -- --run-id <run-id>
```

The recorder creates one continuous H.264 video containing only countries classified as unsupported, plus a chapter index. Raw video remains under `runtime/media-raw/` until it is finalized, metadata-stripped, verified with `ffprobe`, and promoted as the repository’s sole representative MP4.

Finalize, metadata-strip, validate, and promote the sole representative MP4:

```sh
npm run verify-video -- <run-id>
```

### 6. Enrich canonical entries with population

```sh
npm run enrich-population
```

The enrichment downloads the Our World in Data population CSV and metadata, selects 2023 records derived from UN World Population Prospects 2024, hashes both source payloads, and maps three-letter ISO source codes to the canonical selector entries. Duplicate or reused source records fail closed. Entries absent from the primary source remain `null`, never zero.

It writes JSON, CSV, and source-provenance artifacts under `evidence/enrichment/`. If an official-access comparison already exists, the command also refreshes its population fields and population-weighted summaries.

### 7. Enrich canonical entries with active U.S. sanctions programs

```sh
npm run enrich-sanctions
```

The enrichment downloads and hashes the OpenSanctions program directory, selects active U.S.-issued programs containing the documented measures, maps `target_territories` to all 250 canonical codes, and stores program IDs, measures, legal aliases, authoritative URLs, source provenance, attribution, and license metadata. Unmatched entries retain an empty program array.

The command writes only machine-readable evidence and derived comparison artifacts. It never edits `FINDINGS.md` or `README.md`; report interpretation remains manually maintained.

### 8. Compare against OpenAI’s official ChatGPT access list

```sh
npm run compare-official
```

The comparison fetches OpenAI’s official supported-country article, maps every source name to the canonical ISO-coded selector map, fails on unmapped or duplicate entries, joins the committed population and sanctions-program enrichments, and stores JSON and CSV comparison artifacts with source provenance and derived summaries.

### 9. Check before committing

```sh
npm run check
npm test
npm run check-index
```

## Committed evidence

A completed audit contains:

```text
evidence/
├── country-support.json
├── country-support.csv
├── comparisons/
│   ├── openai-chatgpt-supported-countries.json
│   └── openai-chatgpt-supported-countries.csv
├── enrichment/
│   ├── population-2023.json
│   ├── population-2023.csv
│   ├── population-source-metadata.json
│   ├── us-sanctions-programs.json
│   ├── us-sanctions-programs.csv
│   └── us-sanctions-source-metadata.json
├── sanitized-transitions/
│   ├── requests/
│   ├── responses/
│   └── redactions/
├── screenshots/countries/       2 full-page images × every country
├── screenshots/widgets/         2 widget-only images × every country
├── screenshots/comparisons/     1 selected/result composite × every country
├── video/representative/
│   ├── unsupported-country-transitions.mp4
│   └── chapters.json
├── capture-metadata.json
└── manifest.json
```

Screenshots are committed byte-for-byte as captured; side-by-side comparisons are deterministic derived artifacts linked to their source pair. A complete run contains 1,250 screenshots. The representative video is committed once and treated as immutable evidence. Future videos stay under ignored `runtime/`.

## Operator and custody boundaries

The operator navigates, signs in, and clicks **Start verification** before running the scripts. The audited workflow stops at the country/document-class transition: identity documents are not uploaded and identity verification is not completed. Raw captures remain under ignored `runtime/`; terminal output is limited to progress information and excludes raw URLs, headers, bodies, tokens, and identifiers.

## Findings

The completed audit and its limitations are documented in [FINDINGS.md](FINDINGS.md).
