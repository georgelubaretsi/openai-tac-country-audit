import { TextDecoder } from "node:util";

const utf8 = new TextDecoder("utf-8", { fatal: true });
const whitespace = new Set([0x20, 0x09, 0x0a, 0x0d]);

function syntax(message, offset) {
  throw new SyntaxError(`${message} at byte ${offset}`);
}

function decodeString(bytes, start, end) {
  let source;
  try {
    source = utf8.decode(bytes.subarray(start, end));
  } catch {
    syntax("invalid UTF-8 in JSON string", start);
  }
  try {
    return JSON.parse(source);
  } catch {
    syntax("invalid JSON string", start);
  }
}

/**
 * Scans a UTF-8 JSON document without materializing its object graph.
 * String token offsets and paths are byte based; ranges are half open.
 */
export function scanJsonTokens(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const strings = [];
  const scalars = [];
  let cursor = 0;

  const skipWhitespace = () => {
    while (cursor < bytes.length && whitespace.has(bytes[cursor])) cursor += 1;
  };

  const stringToken = (path, isKey) => {
    const start = cursor;
    if (bytes[cursor] !== 0x22) syntax("expected string", cursor);
    cursor += 1;
    const contentStart = cursor;
    while (cursor < bytes.length) {
      const byte = bytes[cursor];
      if (byte === 0x22) {
        const contentEnd = cursor;
        cursor += 1;
        const end = cursor;
        const value = decodeString(bytes, start, end);
        const token = { start, end, contentStart, contentEnd, path: [...path], isKey, value };
        strings.push(token);
        return token;
      }
      if (byte === 0x5c) {
        cursor += 1;
        if (cursor >= bytes.length) syntax("unterminated escape", cursor);
        const escape = bytes[cursor];
        if (escape === 0x75) {
          for (let index = 1; index <= 4; index += 1) {
            const hex = bytes[cursor + index];
            if (hex === undefined || !((hex >= 0x30 && hex <= 0x39) || (hex >= 0x41 && hex <= 0x46) || (hex >= 0x61 && hex <= 0x66))) {
              syntax("invalid Unicode escape", cursor);
            }
          }
          cursor += 5;
          continue;
        }
        if (![0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(escape)) syntax("invalid escape", cursor);
        cursor += 1;
        continue;
      }
      if (byte < 0x20) syntax("unescaped control character", cursor);
      cursor += 1;
    }
    syntax("unterminated string", start);
  };

  const literal = expected => {
    const candidate = bytes.subarray(cursor, cursor + expected.length).toString("ascii");
    if (candidate !== expected) syntax(`expected ${expected}`, cursor);
    cursor += expected.length;
  };

  const number = path => {
    const start = cursor;
    if (bytes[cursor] === 0x2d) cursor += 1;
    if (bytes[cursor] === 0x30) {
      cursor += 1;
    } else if (bytes[cursor] >= 0x31 && bytes[cursor] <= 0x39) {
      while (bytes[cursor] >= 0x30 && bytes[cursor] <= 0x39) cursor += 1;
    } else {
      syntax("invalid number", cursor);
    }
    if (bytes[cursor] === 0x2e) {
      cursor += 1;
      const fractionStart = cursor;
      while (bytes[cursor] >= 0x30 && bytes[cursor] <= 0x39) cursor += 1;
      if (cursor === fractionStart) syntax("invalid fraction", cursor);
    }
    if (bytes[cursor] === 0x65 || bytes[cursor] === 0x45) {
      cursor += 1;
      if (bytes[cursor] === 0x2b || bytes[cursor] === 0x2d) cursor += 1;
      const exponentStart = cursor;
      while (bytes[cursor] >= 0x30 && bytes[cursor] <= 0x39) cursor += 1;
      if (cursor === exponentStart) syntax("invalid exponent", cursor);
    }
    if (cursor === start) syntax("invalid number", cursor);
    scalars.push({ start, end: cursor, path: [...path], type: "number" });
  };

  const value = path => {
    skipWhitespace();
    const byte = bytes[cursor];
    if (byte === 0x22) {
      stringToken(path, false);
      return;
    }
    if (byte === 0x7b) {
      cursor += 1;
      skipWhitespace();
      if (bytes[cursor] === 0x7d) {
        cursor += 1;
        return;
      }
      while (cursor < bytes.length) {
        skipWhitespace();
        const key = stringToken(path, true);
        skipWhitespace();
        if (bytes[cursor] !== 0x3a) syntax("expected colon", cursor);
        cursor += 1;
        value([...path, key.value]);
        skipWhitespace();
        if (bytes[cursor] === 0x7d) {
          cursor += 1;
          return;
        }
        if (bytes[cursor] !== 0x2c) syntax("expected comma or closing brace", cursor);
        cursor += 1;
      }
      syntax("unterminated object", cursor);
    }
    if (byte === 0x5b) {
      cursor += 1;
      skipWhitespace();
      if (bytes[cursor] === 0x5d) {
        cursor += 1;
        return;
      }
      let index = 0;
      while (cursor < bytes.length) {
        value([...path, index]);
        index += 1;
        skipWhitespace();
        if (bytes[cursor] === 0x5d) {
          cursor += 1;
          return;
        }
        if (bytes[cursor] !== 0x2c) syntax("expected comma or closing bracket", cursor);
        cursor += 1;
      }
      syntax("unterminated array", cursor);
    }
    if (byte === 0x74) return literal("true");
    if (byte === 0x66) return literal("false");
    if (byte === 0x6e) return literal("null");
    number(path);
  };

  skipWhitespace();
  value([]);
  skipWhitespace();
  if (cursor !== bytes.length) syntax("trailing JSON data", cursor);
  return { strings, scalars };
}

export function scanJsonStrings(input) {
  return scanJsonTokens(input).strings;
}

/** Applies ordered, non-overlapping half-open byte replacements. */
export function replaceByteSpans(input, replacements) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const ordered = [...replacements].sort((left, right) => left.start - right.start || left.end - right.end);
  const parts = [];
  const changes = [];
  let rawCursor = 0;
  let sanitizedCursor = 0;

  for (let index = 0; index < ordered.length; index += 1) {
    const replacement = ordered[index];
    if (!Number.isSafeInteger(replacement.start) || !Number.isSafeInteger(replacement.end) || replacement.start < rawCursor || replacement.end < replacement.start || replacement.end > bytes.length) {
      throw new RangeError(`invalid or overlapping replacement at index ${index}`);
    }
    const inserted = Buffer.isBuffer(replacement.bytes) ? replacement.bytes : Buffer.from(replacement.bytes);
    const untouched = bytes.subarray(rawCursor, replacement.start);
    parts.push(untouched, inserted);
    sanitizedCursor += untouched.length;
    changes.push({
      index,
      raw_range: { start: replacement.start, end: replacement.end },
      sanitized_range: { start: sanitizedCursor, end: sanitizedCursor + inserted.length },
      replacement: replacement.label,
      reason: replacement.reason
    });
    sanitizedCursor += inserted.length;
    rawCursor = replacement.end;
  }
  parts.push(bytes.subarray(rawCursor));
  return { bytes: Buffer.concat(parts), changes };
}
