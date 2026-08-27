#!/usr/bin/env node

import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { sha256 } from "../lib/runtime.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = resolve(repoRoot, "evidence");

async function inventory(directory, base = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error("symlink under evidence");
    if (entry.isDirectory()) files.push(...await inventory(path, base));
    else if (entry.isFile()) files.push(`evidence/${relative(base, path).split(sep).join("/")}`);
    else throw new Error("special file under evidence");
  }
  return files;
}

const manifest = JSON.parse(await readFile(resolve(evidenceRoot, "manifest.json"), "utf8"));
if (manifest.schema !== "openai-cyber-verification-country-support/evidence-manifest/v1" || !Array.isArray(manifest.files)) {
  throw new Error("evidence manifest contract mismatch");
}
const declared = new Set();
for (const entry of manifest.files) {
  if (declared.has(entry.path) || !entry.path.startsWith("evidence/") || entry.path.includes("..")) {
    throw new Error("invalid or duplicate evidence manifest path");
  }
  declared.add(entry.path);
  const bytes = await readFile(resolve(repoRoot, entry.path));
  if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error("evidence manifest hash mismatch");
}
const actual = new Set((await inventory(evidenceRoot)).filter(path => path !== "evidence/manifest.json"));
if (actual.size !== declared.size || [...actual].some(path => !declared.has(path))) {
  throw new Error("evidence manifest inventory mismatch");
}

const map = JSON.parse(await readFile(resolve(evidenceRoot, "country-support.json"), "utf8"));
if (map.summary.total !== 250 || map.results.length !== 250 || map.summary.unique_codes !== 250 ||
    map.summary.supported + map.summary.unsupported !== 250 || new Set(map.results.map(row => row.code)).size !== 250) {
  throw new Error("canonical country map counts are invalid");
}
const fullScreenshots = [...actual].filter(path => path.startsWith("evidence/screenshots/countries/") && path.endsWith(".webp"));
const widgetScreenshots = [...actual].filter(path => path.startsWith("evidence/screenshots/widgets/") && path.endsWith(".webp"));
const comparisons = [...actual].filter(path => path.startsWith("evidence/screenshots/comparisons/") && path.endsWith(".webp"));
if (fullScreenshots.length !== 500 || widgetScreenshots.length !== 500 || comparisons.length !== 250 ||
    map.results.some(row => {
      const stem = `${String(row.index).padStart(4, "0")}-${row.code}`;
      return !actual.has(`evidence/screenshots/countries/${stem}-selected.webp`) ||
        !actual.has(`evidence/screenshots/countries/${stem}-result.webp`) ||
        !actual.has(`evidence/screenshots/widgets/${stem}-widget-selected.webp`) ||
        !actual.has(`evidence/screenshots/widgets/${stem}-widget-result.webp`) ||
        !actual.has(`evidence/screenshots/comparisons/${stem}-widget-comparison.webp`);
    })) {
  throw new Error("country screenshot and widget comparison sets are incomplete");
}
for (const [prefix, expected] of [
  ["evidence/sanitized-transitions/requests/", 500],
  ["evidence/sanitized-transitions/responses/", 500],
  ["evidence/sanitized-transitions/redactions/", 1000],
]) {
  if ([...actual].filter(path => path.startsWith(prefix)).length !== expected) {
    throw new Error(`sanitized transition inventory mismatch: ${prefix}`);
  }
}

const chapters = JSON.parse(await readFile(resolve(evidenceRoot, "video/representative/chapters.json"), "utf8"));
const unsupported = map.results.filter(row => !row.supported);
if (chapters.chapters.length !== unsupported.length || chapters.chapters.some((chapter, index) => chapter.code !== unsupported[index].code)) {
  throw new Error("representative video chapters do not match unsupported countries");
}
const video = resolve(evidenceRoot, "video/representative/unsupported-country-transitions.mp4");
const probe = JSON.parse((await execFileAsync("ffprobe", [
  "-v", "error", "-show_entries", "format=duration,size:stream=codec_name,pix_fmt,width,height,r_frame_rate",
  "-of", "json", video,
])).stdout);
const stream = probe.streams?.[0];
if (stream?.codec_name !== "h264" || stream.pix_fmt !== "yuv420p" || stream.width % 2 || stream.height % 2 ||
    Number(probe.format?.size) >= 100 * 1024 * 1024) {
  throw new Error("representative video format or size is invalid");
}
console.log(JSON.stringify({
  files: actual.size,
  countries: map.summary.total,
  supported: map.summary.supported,
  unsupported: map.summary.unsupported,
  screenshots: fullScreenshots.length + widgetScreenshots.length + comparisons.length,
  video_chapters: chapters.chapters.length,
  video_bytes: Number(probe.format.size),
  video_duration_seconds: Number(probe.format.duration),
}));
