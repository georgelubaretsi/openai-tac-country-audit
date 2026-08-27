#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CdpClient, CdpError } from "../lib/cdp.mjs";
import { composeWidgetComparison } from "../lib/media.mjs";
import {
  atomicJson,
  atomicWrite,
  prepareRuntime,
  runId as createRunId,
} from "../lib/runtime.mjs";

const RAW_SCHEMA = "openai-cyber-verification-country-support/raw-capture/v1";
const COUNTRY_SELECTOR = "select[name=input_country_select]";
const MIN_SELECTION_DELAY_MS = 3_000;
const MIN_ACTION_DELAY_MS = 1_000;
const EVENT_TIMEOUT_MS = 45_000;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

class CaptureError extends Error {
  constructor(message) {
    super(message);
    this.name = "CaptureError";
  }
}

function parseNonnegativeInteger(value, name) {
  if (!/^\d+$/.test(value)) throw new CaptureError(`${name} must be a nonnegative integer`);
  return Number(value);
}

function parsePositiveInteger(value, name) {
  const parsed = parseNonnegativeInteger(value, name);
  if (parsed === 0) throw new CaptureError(`${name} must be positive`);
  return parsed;
}

function parseArguments(argv) {
  const options = {
    cdp: "http://127.0.0.1:9222",
    runId: createRunId(),
    start: 0,
    end: undefined,
    selectionDelayMs: MIN_SELECTION_DELAY_MS,
    actionDelayMs: MIN_ACTION_DELAY_MS,
    resume: false,
  };

  const aliases = new Map([
    ["selection-delay", "selection-delay-ms"],
    ["action-delay", "action-delay-ms"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--resume") {
      options.resume = true;
      continue;
    }
    if (!argument.startsWith("--")) throw new CaptureError("unexpected positional argument");
    const equals = argument.indexOf("=");
    let name = argument.slice(2, equals === -1 ? undefined : equals);
    name = aliases.get(name) ?? name;
    const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
    if (value === undefined || value.startsWith("--")) throw new CaptureError(`--${name} requires a value`);

    if (name === "cdp") options.cdp = value;
    else if (name === "run-id") options.runId = value;
    else if (name === "start") options.start = parseNonnegativeInteger(value, "--start");
    else if (name === "end") options.end = parseNonnegativeInteger(value, "--end");
    else if (name === "selection-delay-ms") options.selectionDelayMs = parsePositiveInteger(value, "--selection-delay-ms");
    else if (name === "action-delay-ms") options.actionDelayMs = parsePositiveInteger(value, "--action-delay-ms");
    else throw new CaptureError(`unknown option --${name}`);
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.runId)) {
    throw new CaptureError("--run-id must be a safe single path component");
  }
  if (options.selectionDelayMs < MIN_SELECTION_DELAY_MS) {
    throw new CaptureError(`--selection-delay-ms must be at least ${MIN_SELECTION_DELAY_MS}`);
  }
  if (options.actionDelayMs < MIN_ACTION_DELAY_MS) {
    throw new CaptureError(`--action-delay-ms must be at least ${MIN_ACTION_DELAY_MS}`);
  }
  if (options.end !== undefined && options.end < options.start) {
    throw new CaptureError("--end must be greater than or equal to --start");
  }
  try {
    new URL(options.cdp);
  } catch {
    throw new CaptureError("--cdp must be an absolute URL");
  }
  return options;
}

function isAbort(error) {
  return error?.name === "AbortError";
}

function delay(milliseconds, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function relativeToRepo(path) {
  return relative(repoRoot, path).split("\\").join("/");
}

function personaTransition(params) {
  if (params.request?.method !== "POST") return false;
  try {
    const url = new URL(params.request.url);
    return url.hostname === "inquiry.withpersona.com" && url.pathname.endsWith("/transition");
  } catch {
    return false;
  }
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function waitForPromise(promise, { signal, timeoutMs, timeoutMessage }) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, signal.reason);
    const timer = setTimeout(() => finish(reject, new CaptureError(timeoutMessage)), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(value => finish(resolvePromise, value), error => finish(reject, error));
  });
}

class TransitionCapture {
  #client;
  #sessionId;
  #active;
  #unsubscribe;

  constructor(client, sessionId) {
    this.#client = client;
    this.#sessionId = sessionId;
    this.#unsubscribe = client.on("*", event => this.#event(event));
  }

  async capture(action, signal) {
    if (this.#active) throw new CaptureError("transition capture overlap");
    const active = {
      request: deferred(),
      record: undefined,
      extraInfo: new Map(),
      signal,
    };
    this.#active = active;
    try {
      await action();
      const record = await waitForPromise(active.request.promise, {
        signal,
        timeoutMs: EVENT_TIMEOUT_MS,
        timeoutMessage: "no Persona transition request followed submit",
      });
      record.signal = signal;
      return await waitForPromise(record.finished.promise, {
        signal,
        timeoutMs: EVENT_TIMEOUT_MS,
        timeoutMessage: "Persona transition response did not finish",
      });
    } finally {
      this.#active = undefined;
    }
  }

  #event(event) {
    if (event.sessionId !== this.#sessionId || !this.#active) return;
    const { method, params } = event;
    if (method === "Network.requestWillBeSentExtraInfo" || method === "Network.responseReceivedExtraInfo") {
      const extras = this.#active.extraInfo.get(params.requestId) ?? {
        request: [],
        response: [],
      };
      extras[method === "Network.requestWillBeSentExtraInfo" ? "request" : "response"].push(params);
      this.#active.extraInfo.set(params.requestId, extras);
      const record = this.#active.record;
      if (record?.requestId === params.requestId) record.extraInfo = extras;
      return;
    }

    if (method === "Network.requestWillBeSent" && personaTransition(params)) {
      if (this.#active.record) {
        const error = new CaptureError("multiple Persona transition requests followed one submit");
        this.#active.record.finished.reject(error);
        this.#active.request.reject(error);
        return;
      }
      const extraInfo = this.#active.extraInfo.get(params.requestId) ?? { request: [], response: [] };
      this.#active.extraInfo.set(params.requestId, extraInfo);
      const record = {
        requestId: params.requestId,
        requestMeta: params,
        requestPostData: params.request?.postData,
        responseMeta: undefined,
        loadingFinished: undefined,
        extraInfo,
        signal: this.#active.signal,
        finished: deferred(),
      };
      this.#active.record = record;
      this.#active.request.resolve(record);
      return;
    }

    const record = this.#active.record;
    if (!record || params.requestId !== record.requestId) return;
    if (method === "Network.requestWillBeSent") {
      record.finished.reject(new CaptureError("Persona transition request redirected unexpectedly"));
    } else if (method === "Network.responseReceived") {
      record.responseMeta = params;
    } else if (method === "Network.loadingFailed") {
      record.finished.reject(new CaptureError("Persona transition request failed while loading"));
    } else if (method === "Network.loadingFinished") {
      record.loadingFinished = params;
      void this.#finish(record);
    }
  }

  async #finish(record) {
    try {
      if (!record.responseMeta) throw new CaptureError("Persona transition completed without response metadata");
      if (record.responseMeta.hasExtraInfo && record.extraInfo.response.length === 0) {
        const extra = await this.#client.waitForEvent("Network.responseReceivedExtraInfo", {
          sessionId: this.#sessionId,
          predicate: params => params.requestId === record.requestId,
          signal: record.signal,
          timeoutMs: EVENT_TIMEOUT_MS,
        });
        if (!record.extraInfo.response.includes(extra.params)) record.extraInfo.response.push(extra.params);
      }
      let postData = record.requestPostData;
      if (postData === undefined) {
        const result = await this.#client.send("Network.getRequestPostData", {
          requestId: record.requestId,
        }, { sessionId: this.#sessionId, signal: record.signal });
        postData = result.postData;
      }
      if (typeof postData !== "string") throw new CaptureError("Persona transition request body was unavailable");

      const response = await this.#client.send("Network.getResponseBody", {
        requestId: record.requestId,
      }, { sessionId: this.#sessionId, signal: record.signal });
      if (typeof response.body !== "string" || typeof response.base64Encoded !== "boolean") {
        throw new CaptureError("Persona transition response body was unavailable");
      }
      const responseBody = response.base64Encoded
        ? Buffer.from(response.body, "base64")
        : Buffer.from(response.body, "utf8");
      record.finished.resolve({
        requestMeta: {
          requestWillBeSent: record.requestMeta,
          requestWillBeSentExtraInfo: record.extraInfo.request,
        },
        requestBody: Buffer.from(postData, "utf8"),
        responseMeta: {
          responseReceived: record.responseMeta,
          responseReceivedExtraInfo: record.extraInfo.response,
          loadingFinished: record.loadingFinished,
          getResponseBody: { base64Encoded: response.base64Encoded },
        },
        responseBody,
        httpStatus: record.responseMeta.response?.status,
      });
    } catch (error) {
      record.finished.reject(error instanceof CaptureError || error instanceof CdpError
        ? error
        : new CaptureError("failed to retrieve Persona transition bodies"));
    }
  }

  close() {
    this.#unsubscribe();
    if (this.#active) {
      const error = new CaptureError("transition capture closed");
      this.#active.request.reject(error);
      this.#active.record?.finished.reject(error);
      this.#active = undefined;
    }
  }
}

function targetUrlMatches(target, type, hostname, pathname) {
  if (target.type !== type) return false;
  try {
    const url = new URL(target.url);
    return url.hostname === hostname && (url.pathname === pathname || url.pathname === `${pathname}/`);
  } catch {
    return false;
  }
}

async function selectTargets(client, signal) {
  const { targetInfos } = await client.send("Target.getTargets", {}, { signal });
  const pages = targetInfos.filter(target => targetUrlMatches(target, "page", "chatgpt.com", "/cyber"));
  const widgets = targetInfos.filter(target => targetUrlMatches(target, "iframe", "inquiry.withpersona.com", "/widget"));
  if (pages.length !== 1) throw new CaptureError(`expected exactly one ChatGPT cyber page target; found ${pages.length}`);
  if (widgets.length !== 1) throw new CaptureError(`expected exactly one Persona widget iframe target; found ${widgets.length}`);
  return { page: pages[0], widget: widgets[0] };
}

async function evaluate(client, sessionId, expression, signal) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, { sessionId, signal });
  if (result.exceptionDetails) throw new CaptureError("browser evaluation failed");
  return result.result?.value;
}

async function countryOptions(client, sessionId, signal) {
  const result = await evaluate(client, sessionId, `(() => {
    const selects = [...document.querySelectorAll(${JSON.stringify(COUNTRY_SELECTOR)})];
    if (selects.length !== 1) return { selectorCount: selects.length };
    const options = [...selects[0].options]
      .map((option, optionIndex) => ({
        optionIndex,
        code: option.value,
        name: option.label.trim(),
        disabled: option.disabled,
      }))
      .filter(option => !option.disabled && option.code !== "");
    return { selectorCount: 1, options };
  })()`, signal);
  if (!result || result.selectorCount !== 1) {
    throw new CaptureError(`expected exactly one country selector; found ${result?.selectorCount ?? 0}`);
  }
  if (!Array.isArray(result.options) || result.options.length === 0) {
    throw new CaptureError("country selector has no selectable options");
  }
  const seen = new Set();
  for (const option of result.options) {
    if (!Number.isInteger(option.optionIndex) || !/^[A-Z]{2}$/.test(option.code)
      || typeof option.name !== "string" || option.name.length === 0) {
      throw new CaptureError("country selector contains an unsafe or invalid country option");
    }
    if (seen.has(option.code)) throw new CaptureError("country selector contains duplicate country codes");
    seen.add(option.code);
  }
  return result.options.map((option, index) => ({ ...option, index }));
}

async function selectCountry(client, sessionId, option, signal) {
  const result = await evaluate(client, sessionId, `(() => {
    const selects = [...document.querySelectorAll(${JSON.stringify(COUNTRY_SELECTOR)})];
    if (selects.length !== 1) return { ok: false, reason: "selector" };
    const select = selects[0];
    const matches = [...select.options].filter(option => option.value === ${JSON.stringify(option.code)});
    if (matches.length !== 1 || matches[0].disabled || matches[0].index !== ${option.optionIndex}) {
      return { ok: false, reason: "option" };
    }
    select.selectedIndex = matches[0].index;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: select.value === ${JSON.stringify(option.code)}, reason: "selection" };
  })()`, signal);
  if (!result?.ok) throw new CaptureError("country selection failed");
}

async function clickSubmit(client, sessionId, expectedCode, signal) {
  const result = await evaluate(client, sessionId, `(() => {
    const selects = [...document.querySelectorAll(${JSON.stringify(COUNTRY_SELECTOR)})];
    if (selects.length !== 1 || selects[0].value !== ${JSON.stringify(expectedCode)}) {
      return { ok: false, count: 0 };
    }
    const visible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const scope = selects[0].form ?? document;
    const candidates = [...scope.querySelectorAll("button, input[type=submit]")].filter(element => {
      if (element.disabled || !visible(element)) return false;
      const text = (element.innerText || element.value || "").trim();
      return text === "Select";
    });
    if (candidates.length !== 1) return { ok: false, count: candidates.length };
    candidates[0].click();
    return { ok: true, count: 1 };
  })()`, signal);
  if (!result?.ok) throw new CaptureError(`expected exactly one country submit control; found ${result?.count ?? 0}`);
}

async function clickBack(client, sessionId, signal) {
  const result = await evaluate(client, sessionId, `(() => {
    const visible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const candidates = [...document.querySelectorAll("button, [role=button], input[type=button]")].filter(element => {
      const text = (element.innerText || element.value || element.getAttribute("aria-label") || "").trim();
      return !element.disabled && visible(element) && /^back$/i.test(text);
    });
    if (candidates.length !== 1) return { ok: false, count: candidates.length };
    candidates[0].click();
    return { ok: true, count: 1 };
  })()`, signal);
  if (!result?.ok) throw new CaptureError(`expected exactly one Back control; found ${result?.count ?? 0}`);
}

async function waitForDomState(client, sessionId, predicateExpression, description, signal) {
  const deadline = Date.now() + EVENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await evaluate(client, sessionId, predicateExpression, signal)) return;
    await delay(200, signal);
  }
  throw new CaptureError(`timed out waiting for ${description}`);
}

async function waitForBack(client, sessionId, signal) {
  return waitForDomState(client, sessionId, `(() => [...document.querySelectorAll("button, [role=button], input[type=button]")]
    .filter(element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const text = (element.innerText || element.value || element.getAttribute("aria-label") || "").trim();
      return !element.disabled && style.visibility !== "hidden" && style.display !== "none"
        && rect.width > 0 && rect.height > 0 && /^back$/i.test(text);
    }).length === 1)()`, "stable result Back control", signal);
}

async function waitForResult(client, sessionId, classification, signal) {
  return waitForDomState(client, sessionId, `(() => {
    if (document.querySelectorAll(${JSON.stringify(COUNTRY_SELECTOR)}).length !== 0) return false;
    return [...document.querySelectorAll("button, [role=button], input[type=button]")].some(element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const text = (element.innerText || element.value || element.getAttribute("aria-label") || "").trim();
      return !element.disabled && style.visibility !== "hidden" && style.display !== "none"
        && rect.width > 0 && rect.height > 0 && /^back$/i.test(text);
    });
  })()`, `${classification} result`, signal);
}

async function waitForSelector(client, sessionId, signal) {
  return waitForDomState(client, sessionId,
    `document.querySelectorAll(${JSON.stringify(COUNTRY_SELECTOR)}).length === 1`,
    "country selector", signal);
}

async function screenshot(client, pageSessionId, path, signal) {
  const { cssContentSize } = await client.send("Page.getLayoutMetrics", {},
    { sessionId: pageSessionId, signal, timeoutMs: EVENT_TIMEOUT_MS });
  const result = await client.send("Page.captureScreenshot", {
    format: "webp",
    quality: 90,
    fromSurface: true,
    captureBeyondViewport: true,
    clip: {
      x: 0,
      y: 0,
      width: Math.max(1, cssContentSize.width),
      height: Math.max(1, cssContentSize.height),
      scale: 1,
    },
  }, { sessionId: pageSessionId, signal, timeoutMs: EVENT_TIMEOUT_MS });
  if (typeof result.data !== "string") throw new CaptureError("full-page screenshot was unavailable");
  await atomicWrite(path, Buffer.from(result.data, "base64"));
}

async function widgetScreenshot(client, pageSessionId, path, signal) {
  const frame = await evaluate(client, pageSessionId, `(() => {
    const visible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const frames = [...document.querySelectorAll("iframe")].filter(element => {
      try {
        const url = new URL(element.src);
        return url.hostname === "inquiry.withpersona.com" && url.pathname === "/widget" && visible(element);
      } catch {
        return false;
      }
    });
    if (frames.length !== 1) return { count: frames.length };
    const rect = frames[0].getBoundingClientRect();
    return {
      count: 1,
      x: rect.left + scrollX,
      y: rect.top + scrollY,
      width: rect.width,
      height: rect.height,
    };
  })()`, signal);
  if (frame?.count !== 1 || frame.width < 1 || frame.height < 1) {
    throw new CaptureError(`expected exactly one visible Persona widget frame; found ${frame?.count ?? 0}`);
  }
  const result = await client.send("Page.captureScreenshot", {
    format: "webp",
    quality: 90,
    fromSurface: true,
    captureBeyondViewport: true,
    clip: { x: frame.x, y: frame.y, width: frame.width, height: frame.height, scale: 1 },
  }, { sessionId: pageSessionId, signal, timeoutMs: EVENT_TIMEOUT_MS });
  if (typeof result.data !== "string") throw new CaptureError("widget screenshot was unavailable");
  await atomicWrite(path, Buffer.from(result.data, "base64"));
}

function nonempty(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

function classify(responseBody) {
  let payload;
  try {
    payload = JSON.parse(responseBody.toString("utf8"));
  } catch {
    throw new CaptureError("Persona transition response was not valid JSON");
  }
  const attributes = payload?.data?.attributes;
  const countryCode = attributes?.["selected-country-code"];
  const idclasses = attributes?.["next-step"]?.config?.idclasses;
  if (!/^[A-Z]{2}$/.test(countryCode ?? "") || !Array.isArray(idclasses)) {
    throw new CaptureError("Persona transition response had an unexpected result shape");
  }
  return {
    classification: nonempty(idclasses) ? "supported" : "unsupported",
    countryCode,
    idclasses: idclasses.map(item => item?.class).filter(value => typeof value === "string"),
  };
}

async function writeTransitionArtifacts(directory, capture) {
  await prepareRuntime(repoRoot, directory);
  const requestMetaPath = resolve(directory, "request.meta.json");
  const requestBodyPath = resolve(directory, "request.body");
  const responseMetaPath = resolve(directory, "response.meta.json");
  const responseBodyPath = resolve(directory, "response.body");
  const [, requestBody, , responseBody] = await Promise.all([
    atomicJson(requestMetaPath, capture.requestMeta),
    atomicWrite(requestBodyPath, capture.requestBody),
    atomicJson(responseMetaPath, capture.responseMeta),
    atomicWrite(responseBodyPath, capture.responseBody),
  ]);
  return {
    request: {
      meta_path: relativeToRepo(requestMetaPath),
      body_path: relativeToRepo(requestBodyPath),
      bytes: requestBody.bytes,
      sha256: requestBody.sha256,
    },
    response: {
      meta_path: relativeToRepo(responseMetaPath),
      body_path: relativeToRepo(responseBodyPath),
      http_status: capture.httpStatus,
      bytes: responseBody.bytes,
      sha256: responseBody.sha256,
    },
  };
}

function safeFailure(error) {
  if (error instanceof CaptureError || error instanceof CdpError) return error.message;
  if (isAbort(error)) return "capture interrupted";
  return "capture failed unexpectedly";
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const rawRoot = resolve(repoRoot, "runtime", "raw", options.runId);
  const screenshotRoot = resolve(repoRoot, "runtime", "media-raw", options.runId, "screenshots");
  await prepareRuntime(repoRoot, rawRoot);
  await prepareRuntime(repoRoot, screenshotRoot);
  const manifestPath = resolve(rawRoot, "manifest.json");
  let manifest;
  if (options.resume) {
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      throw new CaptureError("resume requested but the raw manifest is unavailable");
    }
    if (manifest.schema !== RAW_SCHEMA || manifest.run_id !== options.runId ||
        !["failed", "interrupted"].includes(manifest.status) || !Array.isArray(manifest.transitions) ||
        manifest.delays_ms?.selection !== options.selectionDelayMs ||
        manifest.delays_ms?.between_actions !== options.actionDelayMs ||
        manifest.transitions.some((transition, index) => transition.index !== index)) {
      throw new CaptureError("raw manifest is not safely resumable");
    }
    manifest.status = "running";
    delete manifest.error;
    delete manifest.signal;
    delete manifest.finished_at;
  } else {
    try {
      await readFile(manifestPath);
      throw new CaptureError("raw run already exists; use --resume or a new run id");
    } catch (error) {
      if (error instanceof CaptureError) throw error;
      if (error.code !== "ENOENT") throw new CaptureError("could not establish a new raw run");
    }
    manifest = {
      schema: RAW_SCHEMA,
      run_id: options.runId,
      status: "running",
      started_at: new Date().toISOString(),
      range: { start: options.start, end: options.end ?? null },
      delays_ms: {
        selection: options.selectionDelayMs,
        between_actions: options.actionDelayMs,
      },
      transitions: [],
    };
  }
  await atomicJson(manifestPath, manifest);
  console.log(`run ${options.runId} ${options.resume ? "resuming" : "started"}`);

  const controller = new AbortController();
  let receivedSignal;
  const stop = signalName => {
    if (receivedSignal) return;
    receivedSignal = signalName;
    controller.abort(new DOMException("Capture interrupted", "AbortError"));
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  let client;
  let tracker;
  try {
    client = await CdpClient.connect(options.cdp, { signal: controller.signal });
    const targets = await selectTargets(client, controller.signal);
    const [pageSessionId, widgetSessionId] = await Promise.all([
      client.attach(targets.page.targetId, { signal: controller.signal }),
      client.attach(targets.widget.targetId, { signal: controller.signal }),
    ]);
    await Promise.all([
      client.send("Page.enable", {}, { sessionId: pageSessionId, signal: controller.signal }),
      client.send("Runtime.enable", {}, { sessionId: pageSessionId, signal: controller.signal }),
      client.send("Runtime.enable", {}, { sessionId: widgetSessionId, signal: controller.signal }),
      client.send("Network.enable", {
        maxTotalBufferSize: 100_000_000,
        maxResourceBufferSize: 20_000_000,
        maxPostDataSize: 20_000_000,
      }, { sessionId: widgetSessionId, signal: controller.signal }),
    ]);
    tracker = new TransitionCapture(client, widgetSessionId);

    const optionsInOrder = await countryOptions(client, widgetSessionId, controller.signal);
    const finalIndex = options.resume
      ? manifest.range.end ?? optionsInOrder.length - 1
      : options.end ?? optionsInOrder.length - 1;
    const startIndex = options.resume ? manifest.transitions.length : options.start;
    if (startIndex >= optionsInOrder.length || finalIndex >= optionsInOrder.length || finalIndex < startIndex ||
        (options.resume && (manifest.option_count !== optionsInOrder.length ||
          manifest.transitions.some((transition, index) =>
            transition.code !== optionsInOrder[index].code || transition.name !== optionsInOrder[index].name)))) {
      throw new CaptureError("requested or resumed country range does not match the selector");
    }
    manifest.range.end = finalIndex;
    manifest.option_count = optionsInOrder.length;
    await atomicJson(manifestPath, manifest);

    for (let index = startIndex; index <= finalIndex; index += 1) {
      const option = optionsInOrder[index];
      const fileStem = `${String(index + 1).padStart(4, "0")}-${option.code}`;
      const selectedPath = resolve(screenshotRoot, `${fileStem}-selected.webp`);
      const resultPath = resolve(screenshotRoot, `${fileStem}-result.webp`);
      const widgetSelectedPath = resolve(screenshotRoot, `${fileStem}-widget-selected.webp`);
      const widgetResultPath = resolve(screenshotRoot, `${fileStem}-widget-result.webp`);
      const comparisonPath = resolve(screenshotRoot, `${fileStem}-widget-comparison.webp`);
      await selectCountry(client, widgetSessionId, option, controller.signal);
      const selectedAt = new Date().toISOString();
      await delay(options.selectionDelayMs, controller.signal);
      await screenshot(client, pageSessionId, selectedPath, controller.signal);
      await widgetScreenshot(client, pageSessionId, widgetSelectedPath, controller.signal);

      const submittedAt = new Date().toISOString();
      const capture = await tracker.capture(
        () => clickSubmit(client, widgetSessionId, option.code, controller.signal),
        controller.signal,
      );
      const resultAt = new Date().toISOString();
      const result = classify(capture.responseBody);
      if (result.countryCode !== option.code) {
        throw new CaptureError("Persona transition result did not match the selected country");
      }
      await waitForResult(client, widgetSessionId, result.classification, controller.signal);
      await delay(options.actionDelayMs, controller.signal);
      await screenshot(client, pageSessionId, resultPath, controller.signal);
      await widgetScreenshot(client, pageSessionId, widgetResultPath, controller.signal);
      const comparison = await composeWidgetComparison(widgetSelectedPath, widgetResultPath, comparisonPath);

      const artifactDirectory = resolve(rawRoot, "transitions", fileStem);
      const artifacts = await writeTransitionArtifacts(artifactDirectory, capture);
      const transition = {
        index,
        code: option.code,
        name: option.name,
        selected_at: selectedAt,
        classification: result.classification,
        idclasses: result.idclasses,
        submitted_at: submittedAt,
        result_at: resultAt,
        request: {
          meta_path: artifacts.request.meta_path,
          body_path: artifacts.request.body_path,
          bytes: artifacts.request.bytes,
          sha256: artifacts.request.sha256,
        },
        response: {
          meta_path: artifacts.response.meta_path,
          body_path: artifacts.response.body_path,
          http_status: artifacts.response.http_status,
          bytes: artifacts.response.bytes,
          sha256: artifacts.response.sha256,
        },
        screenshots: {
          selected_path: relativeToRepo(selectedPath),
          result_path: relativeToRepo(resultPath),
          widget_selected_path: relativeToRepo(widgetSelectedPath),
          widget_result_path: relativeToRepo(widgetResultPath),
          comparison_path: relativeToRepo(comparisonPath),
          comparison,
        },
      };
      manifest.transitions.push(transition);
      await atomicJson(manifestPath, manifest);
      console.log(`${index + 1} ${option.code} ${result.classification}`);

      await delay(options.actionDelayMs, controller.signal);
      await clickBack(client, widgetSessionId, controller.signal);
      if (index < finalIndex) {
        await waitForSelector(client, widgetSessionId, controller.signal);
        await delay(options.actionDelayMs, controller.signal);
      }
    }

    manifest.status = "completed";
    manifest.completed_at = new Date().toISOString();
    await atomicJson(manifestPath, manifest);
  } catch (error) {
    manifest.status = isAbort(error) ? "interrupted" : "failed";
    manifest.finished_at = new Date().toISOString();
    if (receivedSignal) manifest.signal = receivedSignal;
    manifest.error = safeFailure(error);
    await atomicJson(manifestPath, manifest);
    if (!isAbort(error)) console.error(safeFailure(error));
    process.exitCode = receivedSignal === "SIGTERM" ? 143 : receivedSignal === "SIGINT" ? 130 : 1;
  } finally {
    tracker?.close();
    client?.close();
  }
}

await main().catch(error => {
  console.error(safeFailure(error));
  process.exitCode = 1;
});
