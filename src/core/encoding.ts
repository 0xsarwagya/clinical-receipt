const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const BASE64URL_LOOKUP: Record<string, number> = {};
for (let i = 0; i < BASE64URL_ALPHABET.length; i += 1) {
  const char = BASE64URL_ALPHABET[i];
  if (char !== undefined) {
    BASE64URL_LOOKUP[char] = i;
  }
}

export function utf8Bytes(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>;
}

export function bytesToHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, "0");
  }
  return output;
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** RFC 4648 base64url, no padding. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const chunk = (a << 16) | (b << 8) | c;
    output += BASE64URL_ALPHABET[(chunk >>> 18) & 0b111111];
    output += BASE64URL_ALPHABET[(chunk >>> 12) & 0b111111];
    if (i + 1 < bytes.length) {
      output += BASE64URL_ALPHABET[(chunk >>> 6) & 0b111111];
    }
    if (i + 2 < bytes.length) {
      output += BASE64URL_ALPHABET[chunk & 0b111111];
    }
  }
  return output;
}

/** Strict base64url decode — throws SyntaxError on padding or foreign chars. */
export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (value.length % 4 === 1) {
    throw new SyntaxError("base64url string has invalid length");
  }
  const remainder = value.length % 4;
  const byteLength =
    Math.floor(value.length / 4) * 3 + (remainder === 0 ? 0 : remainder - 1);
  const bytes = new Uint8Array(byteLength);
  let buffer = 0;
  let bitsInBuffer = 0;
  let offset = 0;
  for (const char of value) {
    const sextet = BASE64URL_LOOKUP[char];
    if (sextet === undefined) {
      throw new SyntaxError(`invalid base64url character: ${JSON.stringify(char)}`);
    }
    buffer = (buffer << 6) | sextet;
    bitsInBuffer += 6;
    if (bitsInBuffer >= 8) {
      bitsInBuffer -= 8;
      bytes[offset] = (buffer >>> bitsInBuffer) & 0xff;
      offset += 1;
    }
  }
  return bytes;
}

/**
 * The framing primitive from spec/1.0/commitments.md §1:
 * every field is preceded by its byte length as uint32 big-endian, so no
 * two distinct field sequences can collide.
 */
export function frame(fields: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const field of fields) {
    total += 4 + field.length;
  }
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const field of fields) {
    view.setUint32(offset, field.length, false);
    output.set(field, offset + 4);
    offset += 4 + field.length;
  }
  return output;
}

export function concatBytes(
  parts: readonly Uint8Array[],
): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
