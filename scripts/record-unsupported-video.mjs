#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CdpClient } from "../lib/cdp.mjs";
import { atomicJson, prepareRuntime, sleep } from "../lib/runtime.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELECTOR = "select[name=input_country_select]";
const MIN_SELECTION_DELAY_MS = 3_000;
const MIN_ACTION_DELAY_MS = 1_000;
const TIMEOUT_MS = 45_000;

function parseArgs(argv) {
  const options = {
    cdp: "http://127.0.0.1:9222",
    runId: null,
    start: 0,
    end: null,
    selectionDelayMs: MIN_SELECTION_DELAY_MS,
    actionDelayMs: MIN_ACTION_DELAY_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error("unexpected positional argument");
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    if (argument === "--cdp") options.cdp = value;
    else if (argument === "--run-id") options.runId = value;
    else if (argument === "--start") options.start = Number(value);
    else if (argument === "--end") options.end = Number(value);
    else if (argument === "--selection-delay-ms") options.selectionDelayMs = Number(value);
    else if (argument === "--action-delay-ms") options.actionDelayMs = Number(value);
    else throw new Error(`unknown option ${argument}`);
  }
  if (!options.runId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.runId)) {
    throw new Error("--run-id is required and must be a safe path component");
  }
  if (!Number.isSafeInteger(options.start) || options.start < 0 ||
      (options.end !== null && (!Number.isSafeInteger(options.end) || options.end < options.start))) {
    throw new Error("--start/--end must define a nonnegative inclusive range");
  }
  if (options.selectionDelayMs < MIN_SELECTION_DELAY_MS || options.actionDelayMs < MIN_ACTION_DELAY_MS) {
    throw new Error("video timing cannot be faster than 3000ms selection and 1000ms action delays");
  }
  return options;
}

async function evaluate(client, sessionId, expression, signal) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, { sessionId, signal, timeoutMs: TIMEOUT_MS });
  if (result.exceptionDetails) throw new Error("browser evaluation failed");
  return result.result?.value;
}

async function targets(client, signal) {
  const { targetInfos } = await client.send("Target.getTargets", {}, { signal });
  const page = targetInfos.filter(target => {
    try {
      const url = new URL(target.url);
      return target.type === "page" && url.hostname === "chatgpt.com" && url.pathname === "/cyber";
    } catch { return false; }
  });
  const widget = targetInfos.filter(target => {
    try {
      const url = new URL(target.url);
      return target.type === "iframe" && url.hostname === "inquiry.withpersona.com" && url.pathname === "/widget";
    } catch { return false; }
  });
  if (page.length !== 1 || widget.length !== 1) {
    throw new Error(`expected one cyber page and one Persona widget; found ${page.length} and ${widget.length}`);
  }
  return { page: page[0], widget: widget[0] };
}

async function waitFor(client, sessionId, expression, description, signal) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await evaluate(client, sessionId, expression, signal)) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function selectCountry(client, sessionId, code, signal) {
  const ok = await evaluate(client, sessionId, `(() => {
    const select = document.querySelector(${JSON.stringify(SELECTOR)});
    if (!select) return false;
    const matches = [...select.options].filter(option => option.value === ${JSON.stringify(code)} && !option.disabled);
    if (matches.length !== 1) return false;
    select.value = ${JSON.stringify(code)};
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return select.value === ${JSON.stringify(code)};
  })()`, signal);
  if (!ok) throw new Error(`could not select country ${code}`);
}

async function clickButton(client, sessionId, kind, signal) {
  const ok = await evaluate(client, sessionId, `(() => {
    const visible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const buttons = [...document.querySelectorAll("button, [role=button], input[type=submit]")]
      .filter(element => !element.disabled && visible(element));
    const candidates = buttons.filter(element => {
      const text = (element.innerText || element.value || element.getAttribute("aria-label") || "").trim();
      return ${kind === "submit" ? "text === 'Select'" : "/^back$/i.test(text)"};
    });
    if (candidates.length !== 1) return false;
    candidates[0].click();
    return true;
  })()`, signal);
  if (!ok) throw new Error(`expected exactly one ${kind} button`);
}

async function startVideo(client, pageSessionId, output, signal) {
  const ffmpeg = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "image2pipe", "-framerate", "10", "-vcodec", "mjpeg", "-i", "-",
    "-an", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", output,
  ], { stdio: ["pipe", "ignore", "inherit"] });
  const exitPromise = new Promise(resolvePromise =>
    ffmpeg.once("exit", (code, exitSignal) => resolvePromise({ code, signal: exitSignal })));
  let streamError = null;
  ffmpeg.stdin.on("error", error => { streamError = error; });
  await new Promise((resolvePromise, rejectPromise) => {
    ffmpeg.once("spawn", resolvePromise);
    ffmpeg.once("error", rejectPromise);
  });
  let latestFrame;
  let sourceFrames = 0;
  let encodedFrames = 0;
  const unsubscribe = client.on("Page.screencastFrame", event => {
    if (event.sessionId !== pageSessionId) return;
    latestFrame = Buffer.from(event.params.data, "base64");
    sourceFrames += 1;
    client.send("Page.screencastFrameAck", { sessionId: event.params.sessionId },
      { sessionId: pageSessionId }).catch(() => {});
  });
  await client.send("Page.startScreencast", {
    format: "jpeg",
    quality: 95,
    maxWidth: 1440,
    maxHeight: 1440,
    everyNthFrame: 1,
  }, { sessionId: pageSessionId, signal, timeoutMs: TIMEOUT_MS });
  const timer = setInterval(() => {
    if (!latestFrame || streamError || ffmpeg.stdin.destroyed || ffmpeg.stdin.writableNeedDrain) return;
    ffmpeg.stdin.write(latestFrame);
    encodedFrames += 1;
  }, 100);
  return {
    timeMs: () => Math.round(encodedFrames * 100),
    stop: async () => {
      clearInterval(timer);
      unsubscribe();
      try { await client.send("Page.stopScreencast", {}, { sessionId: pageSessionId }); } catch {}
      if (!ffmpeg.stdin.destroyed) ffmpeg.stdin.end();
      const exit = await exitPromise;
      if (exit.code !== 0) throw new Error(`ffmpeg exited with ${exit.code ?? exit.signal}`);
      if (streamError) throw streamError;
      return { source_frames: sourceFrames, encoded_frames: encodedFrames, fps: 10 };
    },
  };
}

function mapRows(payload) {
  let rows;
  if (Array.isArray(payload)) rows = payload;
  else if (Array.isArray(payload.results)) rows = payload.results;
  else if (Array.isArray(payload.country_codes) && payload.countries && typeof payload.countries === "object") {
    rows = payload.country_codes.map((code, index) => ({ index: index + 1, code, ...payload.countries[code] }));
  }
  if (!Array.isArray(rows)) throw new Error("canonical support map has no ordered country results");
  const seen = new Set();
  for (const row of rows) {
    if (!/^[A-Z]{2}$/.test(row.code ?? "") || typeof row.name !== "string" || typeof row.supported !== "boolean") {
      throw new Error("canonical support map has an invalid row");
    }
    if (seen.has(row.code)) throw new Error("canonical support map has duplicate country codes");
    seen.add(row.code);
  }
  return rows;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const mapPath = resolve(repoRoot, "runtime", "sanitized-staging", options.runId, "canonical-support-map.json");
  const rows = mapRows(JSON.parse(await readFile(mapPath, "utf8")));
  const unsupported = rows.filter(row => !row.supported);
  const finalIndex = options.end ?? unsupported.length - 1;
  if (options.start >= unsupported.length || finalIndex >= unsupported.length) {
    throw new Error("video range exceeds unsupported country count");
  }
  const selectedRows = unsupported.slice(options.start, finalIndex + 1);
  const outputDirectory = resolve(repoRoot, "runtime", "media-raw", options.runId, "video");
  await prepareRuntime(repoRoot, outputDirectory);
  const output = resolve(outputDirectory, "unsupported-country-transitions.raw.mp4");
  const partialOutput = `${output}.partial.mp4`;
  const chaptersPath = resolve(outputDirectory, "chapters.json");

  const controller = new AbortController();
  let receivedSignal = null;
  const stop = signalName => {
    if (receivedSignal) return;
    receivedSignal = signalName;
    controller.abort(new DOMException("video interrupted", "AbortError"));
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  let client;
  let recording;
  let videoMeta;
  const chapters = [];
  const startedAt = new Date().toISOString();
  let failure;
  try {
    client = await CdpClient.connect(options.cdp, { signal: controller.signal });
    const selectedTargets = await targets(client, controller.signal);
    const [pageSessionId, widgetSessionId] = await Promise.all([
      client.attach(selectedTargets.page.targetId, { signal: controller.signal }),
      client.attach(selectedTargets.widget.targetId, { signal: controller.signal }),
    ]);
    await Promise.all([
      client.send("Page.enable", {}, { sessionId: pageSessionId, signal: controller.signal }),
      client.send("Runtime.enable", {}, { sessionId: widgetSessionId, signal: controller.signal }),
      client.send("Network.enable", {}, { sessionId: widgetSessionId, signal: controller.signal }),
    ]);
    await waitFor(client, widgetSessionId,
      `document.querySelectorAll(${JSON.stringify(SELECTOR)}).length === 1`, "country selector", controller.signal);
    recording = await startVideo(client, pageSessionId, partialOutput, controller.signal);

    for (const row of selectedRows) {
      await selectCountry(client, widgetSessionId, row.code, controller.signal);
      const selectedAtMs = recording.timeMs();
      await sleep(options.selectionDelayMs);
      const requestPromise = client.waitForEvent("Network.requestWillBeSent", {
        sessionId: widgetSessionId,
        predicate: params => {
          if (params.request?.method !== "POST") return false;
          try {
            const url = new URL(params.request.url);
            return url.hostname === "inquiry.withpersona.com" && url.pathname.endsWith("/transition");
          } catch {
            return false;
          }
        },
        signal: controller.signal,
        timeoutMs: TIMEOUT_MS,
      });
      requestPromise.catch(() => {});
      const submittedAtMs = recording.timeMs();
      await clickButton(client, widgetSessionId, "submit", controller.signal);
      const requestEvent = await requestPromise;
      await client.waitForEvent("Network.responseReceived", {
        sessionId: widgetSessionId,
        predicate: params => params.requestId === requestEvent.params.requestId,
        signal: controller.signal,
        timeoutMs: TIMEOUT_MS,
      });
      await waitFor(client, widgetSessionId, `(() =>
        document.querySelectorAll(${JSON.stringify(SELECTOR)}).length === 0 &&
        document.body.innerText.includes("Unable to verify"))()`, "unsupported result", controller.signal);
      const resultAtMs = recording.timeMs();
      await sleep(options.actionDelayMs);
      await clickButton(client, widgetSessionId, "back", controller.signal);
      await sleep(options.actionDelayMs);
      await waitFor(client, widgetSessionId,
        `document.querySelectorAll(${JSON.stringify(SELECTOR)}).length === 1`, "country selector", controller.signal);
      const endedAtMs = recording.timeMs();
      chapters.push({
        index: row.index,
        code: row.code,
        name: row.name,
        supported: false,
        selected_at_ms: selectedAtMs,
        submitted_at_ms: submittedAtMs,
        result_at_ms: resultAtMs,
        ended_at_ms: endedAtMs,
      });
      await atomicJson(chaptersPath, {
        schema: "openai-cyber-verification-country-support/video-chapters/v1",
        run_id: options.runId,
        status: "recording",
        started_at: startedAt,
        chapters,
      });
      console.log(`${chapters.length}/${selectedRows.length} ${row.code} recorded`);
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (recording) videoMeta = await recording.stop();
    } catch (error) {
      failure ??= error;
    }
    client?.close();
  }
  if (!failure && videoMeta) {
    await chmod(partialOutput, 0o600);
    await rename(partialOutput, output);
  }

  await atomicJson(chaptersPath, {
    schema: "openai-cyber-verification-country-support/video-chapters/v1",
    run_id: options.runId,
    status: failure || receivedSignal ? "interrupted" : "completed",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    signal: receivedSignal,
    video: videoMeta,
    chapters,
  });
  if (failure) throw new Error("video recording failed");
  if (receivedSignal) process.exitCode = receivedSignal === "SIGINT" ? 130 : 143;
}

await main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
