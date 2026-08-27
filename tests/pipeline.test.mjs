import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { sha256 } from "../lib/runtime.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runId = `synthetic-${process.pid}`;
const rawRoot = resolve(repoRoot, "runtime", "raw", runId);
const stagingRoot = resolve(repoRoot, "runtime", "sanitized-staging", runId);
const repoRelative = path => relative(repoRoot, path).split(sep).join("/");

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: 0o600 });
}

test("raw capture sanitizes and audits without reconstruction", async () => {
  await rm(rawRoot, { recursive: true, force: true });
  await rm(stagingRoot, { recursive: true, force: true });
  const transitionRoot = resolve(rawRoot, "transitions", "0001-AF");
  const requestMetaPath = resolve(transitionRoot, "request.meta.json");
  const requestBodyPath = resolve(transitionRoot, "request.body");
  const responseMetaPath = resolve(transitionRoot, "response.meta.json");
  const responseBodyPath = resolve(transitionRoot, "response.body");
  const boundary = "----SyntheticBoundary";
  const requestBody = Buffer.from([
    `--${boundary}`,
    'Content-Disposition: form-data; name="data[id]"',
    "",
    "inq_SyntheticSensitiveInquiry123",
    `--${boundary}`,
    'Content-Disposition: form-data; name="data[attributes][componentParams][input_country_select]"',
    "",
    "AF",
    `--${boundary}`,
    'Content-Disposition: form-data; name="meta[from-step]"',
    "",
    "gov_id_country_select",
    `--${boundary}--`,
    "",
  ].join("\r\n"));
  const responseBody = Buffer.from(JSON.stringify({
    data: {
      type: "inquiry",
      id: "inq_SyntheticSensitiveInquiry123",
      attributes: {
        "reference-id": "user-SyntheticSensitiveReference456",
        "selected-country-code": "AF",
        "next-step": {
          type: "government_id",
          name: "gov_id_verification",
          config: {
            idclasses: [],
            localizations: {
              "unsupported-title": "Unable to verify",
              "unsupported-prompt": "We are unable to verify identities in this country. Please select another country.",
            },
          },
        },
      },
    },
  }));
  const requestMeta = {
    requestWillBeSent: {
      requestId: "synthetic-request-id",
      request: {
        method: "POST",
        url: "https://inquiry.withpersona.com/api/internal/verify/v1/inquiries/inq_SyntheticSensitiveInquiry123/transition",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          Authorization: "Bearer SyntheticSensitiveAuthorization789",
          Cookie: "session=SyntheticSensitiveCookie012",
          "Persona-Device-Id": "dev_SyntheticSensitiveDevice345",
        },
      },
    },
    requestWillBeSentExtraInfo: [],
  };
  const responseMeta = {
    responseReceived: {
      requestId: "synthetic-request-id",
      response: {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "session=SyntheticSensitiveCookie012",
          "X-Traceparent": "00-11111111111111111111111111111111-2222222222222222-01",
        },
      },
    },
    responseReceivedExtraInfo: [],
    loadingFinished: { requestId: "synthetic-request-id" },
    getResponseBody: { base64Encoded: false },
  };
  await write(requestMetaPath, `${JSON.stringify(requestMeta)}\n`);
  await write(requestBodyPath, requestBody);
  await write(responseMetaPath, `${JSON.stringify(responseMeta)}\n`);
  await write(responseBodyPath, responseBody);
  const manifest = {
    schema: "openai-cyber-verification-country-support/raw-capture/v1",
    run_id: runId,
    status: "completed",
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:10.000Z",
    range: { start: 0, end: 0 },
    option_count: 1,
    transitions: [{
      index: 0,
      code: "AF",
      name: "Afghanistan",
      selected_at: "2026-01-01T00:00:01.000Z",
      submitted_at: "2026-01-01T00:00:04.000Z",
      result_at: "2026-01-01T00:00:05.000Z",
      request: {
        meta_path: repoRelative(requestMetaPath),
        body_path: repoRelative(requestBodyPath),
        bytes: requestBody.length,
        sha256: sha256(requestBody),
      },
      response: {
        meta_path: repoRelative(responseMetaPath),
        body_path: repoRelative(responseBodyPath),
        http_status: 200,
        bytes: responseBody.length,
        sha256: sha256(responseBody),
      },
      screenshots: { selected_path: null, result_path: null },
    }],
  };
  await write(resolve(rawRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  try {
    await execFileAsync(process.execPath, ["scripts/sanitize-capture.mjs", runId], { cwd: repoRoot });
    await execFileAsync(process.execPath, ["scripts/audit-sanitized-evidence.mjs", runId], { cwd: repoRoot }).catch(() => {});
    const support = JSON.parse(await readFile(resolve(stagingRoot, "canonical-support-map.json"), "utf8"));
    assert.equal(support.countries.AF.supported, false);
    const sanitizedManifest = JSON.parse(await readFile(resolve(stagingRoot, "manifest.json"), "utf8"));
    const responsePath = resolve(stagingRoot, sanitizedManifest.transitions[0].response.body_path);
    const sanitizedResponse = await readFile(responsePath, "utf8");
    assert.doesNotMatch(sanitizedResponse, /SyntheticSensitive/);
    assert.match(sanitizedResponse, /Unable to verify/);
    const responseMetaPath = resolve(stagingRoot, sanitizedManifest.transitions[0].response.meta_path);
    const sanitizedResponseMeta = await readFile(responseMetaPath, "utf8");
    assert.doesNotMatch(sanitizedResponseMeta, /11111111111111111111111111111111/);
    assert.match(sanitizedResponseMeta, /"x-traceparent":"\[REDACTED\]"/i);
    const audit = JSON.parse(await readFile(resolve(stagingRoot, "audit-report.json"), "utf8"));
    assert.equal(audit.passed, true, JSON.stringify(audit.issues));
  } finally {
    if (!process.env.KEEP_SYNTHETIC) {
      await rm(rawRoot, { recursive: true, force: true });
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }
});
