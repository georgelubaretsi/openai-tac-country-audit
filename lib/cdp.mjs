const DEFAULT_TIMEOUT_MS = 15_000;

export class CdpError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CdpError";
    Object.assign(this, details);
  }
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function withAbortAndTimeout({ signal, timeoutMs, onAbort, onTimeout }) {
  let timer;
  const abort = () => onAbort(abortError(signal));
  if (signal) signal.addEventListener("abort", abort, { once: true });
  if (timeoutMs > 0) timer = setTimeout(onTimeout, timeoutMs);
  return () => {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abort);
  };
}

async function browserWebSocketUrl(endpoint, signal, timeoutMs) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new CdpError("CDP endpoint must be an absolute URL");
  }
  if (url.protocol === "ws:" || url.protocol === "wss:") return url.href;
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CdpError("CDP endpoint must use http, https, ws, or wss");
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const fetchSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response;
  try {
    response = await fetch(new URL("/json/version", url), {
      signal: fetchSignal,
      redirect: "error",
    });
  } catch {
    if (signal?.aborted) throw abortError(signal);
    throw new CdpError("CDP version endpoint was unavailable");
  }
  if (!response.ok) throw new CdpError("CDP version endpoint was unavailable");
  let version;
  try {
    version = await response.json();
  } catch {
    throw new CdpError("CDP version endpoint returned invalid JSON");
  }
  if (typeof version.webSocketDebuggerUrl !== "string") {
    throw new CdpError("CDP version endpoint did not expose a browser WebSocket");
  }
  return version.webSocketDebuggerUrl;
}

export class CdpClient {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #closed = false;

  static async connect(endpoint, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    throwIfAborted(signal);
    const webSocketUrl = await browserWebSocketUrl(endpoint, signal, timeoutMs);
    const socket = new WebSocket(webSocketUrl);

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const cleanupControl = withAbortAndTimeout({
        signal,
        timeoutMs,
        onAbort: error => {
          socket.close();
          finish(reject, error);
        },
        onTimeout: () => {
          socket.close();
          finish(reject, new CdpError("Timed out connecting to the CDP browser"));
        },
      });
      const onOpen = () => finish(resolve);
      const onError = () => finish(reject, new CdpError("Unable to connect to the CDP browser"));
      const cleanup = () => {
        cleanupControl();
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
      };
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
    });

    return new CdpClient(socket);
  }

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", event => this.#onMessage(event));
    socket.addEventListener("close", () => this.#onClose());
    socket.addEventListener("error", () => this.#onClose());
  }

  async #onMessage(event) {
    let text;
    if (typeof event.data === "string") text = event.data;
    else if (event.data instanceof ArrayBuffer) text = Buffer.from(event.data).toString("utf8");
    else if (ArrayBuffer.isView(event.data)) text = Buffer.from(event.data.buffer, event.data.byteOffset, event.data.byteLength).toString("utf8");
    else if (event.data && typeof event.data.text === "function") text = await event.data.text();
    else return;

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.close();
      return;
    }

    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      pending.cleanup();
      if (message.error) {
        pending.reject(new CdpError(`CDP command failed: ${pending.method}`, {
          method: pending.method,
          code: message.error.code,
        }));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (typeof message.method !== "string") return;
    const eventRecord = {
      method: message.method,
      params: message.params ?? {},
      sessionId: message.sessionId,
    };
    for (const listener of this.#listeners.get(message.method) ?? []) listener(eventRecord);
    for (const listener of this.#listeners.get("*") ?? []) listener(eventRecord);
  }

  #onClose() {
    if (this.#closed) return;
    this.#closed = true;
    const error = new CdpError("CDP browser connection closed");
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.#pending.clear();
    const closedEvent = { method: "__closed", params: {}, sessionId: undefined };
    for (const listener of this.#listeners.get("__closed") ?? []) listener(closedEvent);
  }

  send(method, params = {}, { sessionId, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    throwIfAborted(signal);
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new CdpError("CDP browser connection is not open"));
    }

    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const finishWithError = error => {
        if (!this.#pending.delete(id)) return;
        cleanup();
        reject(error);
      };
      const cleanup = withAbortAndTimeout({
        signal,
        timeoutMs,
        onAbort: finishWithError,
        onTimeout: () => finishWithError(new CdpError(`Timed out waiting for CDP command: ${method}`, { method })),
      });
      this.#pending.set(id, { method, resolve, reject, cleanup });
      try {
        this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch {
        finishWithError(new CdpError(`Unable to send CDP command: ${method}`, { method }));
      }
    });
  }

  on(method, listener) {
    const listeners = this.#listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(method);
    };
  }

  waitForEvent(method, {
    sessionId,
    predicate = () => true,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    throwIfAborted(signal);
    if (this.#closed) return Promise.reject(new CdpError("CDP browser connection is closed"));

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        unsubscribeClosed();
        cleanup();
        callback(value);
      };
      const listener = event => {
        if (sessionId !== undefined && event.sessionId !== sessionId) return;
        let matches;
        try {
          matches = predicate(event.params, event);
        } catch (error) {
          finish(reject, error);
          return;
        }
        if (matches) finish(resolve, event);
      };
      const unsubscribe = this.on(method, listener);
      const unsubscribeClosed = this.on("__closed", () => {
        finish(reject, new CdpError("CDP browser connection closed while waiting for an event"));
      });
      const cleanup = withAbortAndTimeout({
        signal,
        timeoutMs,
        onAbort: error => finish(reject, error),
        onTimeout: () => finish(reject, new CdpError(`Timed out waiting for CDP event: ${method}`, { method })),
      });
    });
  }

  async attach(targetId, options = {}) {
    const { sessionId } = await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    }, options);
    return sessionId;
  }

  close() {
    if (this.#closed) return;
    this.#socket.close();
    this.#onClose();
  }
}
