#!/usr/bin/env node

import { execFile } from "node:child_process";
import { chmod, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { atomicJson, sha256 } from "../lib/runtime.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runId = process.argv[2];
if (process.argv.length !== 3 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId ?? "")) {
  throw new Error("usage: node scripts/verify-video.mjs <run-id>");
}

const rawVideo = resolve(repoRoot, "runtime", "media-raw", runId, "video", "unsupported-country-transitions.raw.mp4");
const rawChapters = resolve(repoRoot, "runtime", "media-raw", runId, "video", "chapters.json");
const mapPath = resolve(repoRoot, "evidence", "country-support.json");
const manifestPath = resolve(repoRoot, "evidence", "manifest.json");
const output = resolve(repoRoot, "evidence", "video", "representative", "unsupported-country-transitions.mp4");
const outputChapters = resolve(repoRoot, "evidence", "video", "representative", "chapters.json");
const temporary = `${output}.partial-${process.pid}.mp4`;

const [map, chapters, manifest] = await Promise.all([
  readFile(mapPath, "utf8").then(JSON.parse),
  readFile(rawChapters, "utf8").then(JSON.parse),
  readFile(manifestPath, "utf8").then(JSON.parse),
]);
const unsupported = map.results.filter(result => !result.supported);
if (chapters.status !== "completed" || chapters.run_id !== runId || !Array.isArray(chapters.chapters)) {
  throw new Error("video chapters do not describe a completed run");
}
if (chapters.chapters.length !== unsupported.length || chapters.chapters.some((chapter, index) =>
  chapter.code !== unsupported[index].code || chapter.name !== unsupported[index].name || chapter.supported !== false ||
  !Number.isSafeInteger(chapter.selected_at_ms) || !Number.isSafeInteger(chapter.result_at_ms) ||
  chapter.result_at_ms <= chapter.selected_at_ms || chapter.ended_at_ms <= chapter.result_at_ms)) {
  throw new Error("video chapters do not exactly cover the unsupported country map");
}
if (manifest.files.some(file => file.path.endsWith(".mp4") || file.path === "evidence/video/representative/chapters.json")) {
  throw new Error("representative video is already recorded in the evidence manifest");
}

const probe = async path => JSON.parse((await execFileAsync("ffprobe", [
  "-v", "error", "-show_entries", "format=duration,size:stream=codec_name,pix_fmt,width,height,r_frame_rate",
  "-of", "json", path,
])).stdout);
const rawProbe = await probe(rawVideo);
const rawStream = rawProbe.streams?.find(stream => stream.codec_name === "h264");
if (!rawStream || rawStream.pix_fmt !== "yuv420p" || rawStream.width % 2 || rawStream.height % 2) {
  throw new Error("raw video codec, pixel format, or dimensions are invalid");
}
const rawDurationMs = Math.round(Number(rawProbe.format?.duration) * 1000);
if (!Number.isFinite(rawDurationMs) || rawDurationMs < chapters.chapters.at(-1).result_at_ms) {
  throw new Error("raw video duration does not cover the final chapter");
}

await execFileAsync("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-i", rawVideo,
  "-map_metadata", "-1", "-c", "copy", "-movflags", "+faststart", "-y", temporary,
]);
await chmod(temporary, 0o644);
await rename(temporary, output);
const finalProbe = await probe(output);
const finalBytes = await readFile(output);
if (finalBytes.length > 95 * 1024 * 1024 || finalProbe.streams?.[0]?.codec_name !== "h264") {
  throw new Error("representative video exceeds the normal-Git size budget or has the wrong codec");
}
const committedChapters = {
  schema: chapters.schema,
  run_id: runId,
  status: "completed",
  chapters: chapters.chapters,
};
await atomicJson(outputChapters, committedChapters);
await chmod(outputChapters, 0o644);
const chapterBytes = await readFile(outputChapters);
manifest.files.push(
  {
    path: "evidence/video/representative/unsupported-country-transitions.mp4",
    kind: "representative-unsupported-transition-video",
    bytes: finalBytes.length,
    sha256: sha256(finalBytes),
  },
  {
    path: "evidence/video/representative/chapters.json",
    kind: "representative-video-chapters",
    bytes: chapterBytes.length,
    sha256: sha256(chapterBytes),
  },
);
manifest.files.sort((left, right) => left.path.localeCompare(right.path));
await atomicJson(manifestPath, manifest);
await chmod(manifestPath, 0o644);
console.log(`Verified and promoted ${chapters.chapters.length} unsupported-country chapters.`);
