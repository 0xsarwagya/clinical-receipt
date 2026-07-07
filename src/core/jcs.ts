import { ReceiptError } from "../errors.js";
import { utf8Bytes } from "./encoding.js";

/**
 * RFC 8785 JSON Canonicalization Scheme.
 *
 * ECMAScript's native JSON.stringify already produces JCS-conformant
 * serializations of strings (minimal escaping) and numbers
 * (shortest-round-trip Number::toString), so canonicalization reduces to
 * recursive member sorting — plus refusing every input JSON would
 * silently reshape. Implementations in other languages must match the
 * ECMAScript number formatting exactly (Ryu or equivalent).
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function fail(message: string): never {
  throw new ReceiptError({
    code: "CANONICALIZATION_FAILED",
    message,
    operation: "canonicalize",
  });
}

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function serialize(value: unknown, path: string): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        fail(`non-finite number at ${path} — JSON would reshape it`);
      }
      // JSON.stringify(-0) === "0", which is exactly the JCS rule.
      return JSON.stringify(value);
    }
    case "string": {
      if (hasLoneSurrogate(value)) {
        fail(`string with lone surrogate at ${path} — not well-formed Unicode`);
      }
      return JSON.stringify(value);
    }
    case "undefined":
      fail(`undefined at ${path} — JSON cannot carry it`);
      break;
    case "bigint":
      fail(`BigInt at ${path} — JSON cannot carry it`);
      break;
    case "function":
    case "symbol":
      fail(`${typeof value} at ${path} — JSON cannot carry it`);
      break;
    default:
      break;
  }

  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i += 1) {
      if (!(i in value)) {
        fail(`sparse array hole at ${path}[${i}]`);
      }
      parts.push(serialize(value[i], `${path}[${i}]`));
    }
    return `[${parts.join(",")}]`;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`non-plain object at ${path} — JSON would silently reshape it`);
  }

  const record = value as Record<string, unknown>;
  // RFC 8785 §3.2.3: sort by UTF-16 code units — the default sort order.
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    if (hasLoneSurrogate(key)) {
      fail(`object key with lone surrogate at ${path}`);
    }
    parts.push(
      `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`)}`,
    );
  }
  return `{${parts.join(",")}}`;
}

/** Canonical JCS text of a JSON value. Throws CANONICALIZATION_FAILED. */
export function jcsSerialize(value: unknown): string {
  return serialize(value, "$");
}

/** Canonical JCS bytes (UTF-8). */
export function jcsBytes(value: unknown): Uint8Array<ArrayBuffer> {
  return utf8Bytes(jcsSerialize(value));
}
