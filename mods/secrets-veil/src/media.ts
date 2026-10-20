/**
 * Image payloads that may pass the veil unmasked, and the checks they must pass.
 *
 * An image payload is one long high-entropy base64 run, so the entropy layer
 * covered it and the API rejected every image Read (card
 * image-read-fault-2026-10-18). A payload passes only when ALL hold
 * (Codex XREVIEW HOLD 6288472542 on orchestkit#4801):
 *   - its media type is on the allowlist (a Map: no inherited keys);
 *   - the text is strict base64 (length a multiple of 4, padding only at the
 *     end) and under the size cap;
 *   - the WHOLE decoded file has the structure of its type, end to end
 *     (PNG chunks with CRCs, JPEG segments to EOI, GIF blocks to the trailer,
 *     WebP RIFF chunks to the exact end), not only a file signature;
 *   - the caller checks it holds no named value or vendor shape (holdsSecret).
 * Pure: the mod sandbox may have neither Buffer nor atob.
 */

/** Most base64 characters one image payload may carry (about 12 MB decoded). */
export const MAX_MEDIA_CHARS = 16_000_000;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map<string, number>(Array.from(B64, (c, i) => [c, i] as [string, number]));

/** Strict base64 to bytes, or null: wrong length, bad padding, a foreign character, or over the cap. */
export function decodeBase64Strict(text: string): Uint8Array | null {
  if (typeof text !== "string" || text.length === 0 || text.length % 4 !== 0 || text.length > MAX_MEDIA_CHARS) {
    return null;
  }
  const pad = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const body = text.length - pad;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const q: number[] = [];
    for (let k = 0; k < 4; k++) {
      const pos = i + k;
      if (pos >= body) {
        q.push(0);
        continue;
      }
      const v = B64_INDEX.get(text[pos]);
      if (v === undefined) return null;
      q.push(v);
    }
    const word = (q[0] << 18) | (q[1] << 12) | (q[2] << 6) | q[3];
    const bytes = [(word >> 16) & 0xff, (word >> 8) & 0xff, word & 0xff];
    for (const b of bytes) {
      if (o < out.length) out[o++] = b;
    }
  }
  // Non-canonical padding bits (e.g. "QR==" for one byte) mean the text is not the canonical encoding.
  if (pad === 2 && (B64_INDEX.get(text[body - 1])! & 0x0f) !== 0) return null;
  if (pad === 1 && (B64_INDEX.get(text[body - 1])! & 0x03) !== 0) return null;
  return out;
}

let CRC_TABLE: Uint32Array | null = null;
function crc32(bytes: Uint8Array, start: number, end: number): number {
  if (CRC_TABLE === null) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u32be = (b: Uint8Array, i: number): number => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u32le = (b: Uint8Array, i: number): number => ((b[i + 3] << 24) | (b[i + 2] << 16) | (b[i + 1] << 8) | b[i]) >>> 0;
const startsWith = (b: Uint8Array, prefix: number[]): boolean => prefix.every((v, i) => b[i] === v);
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

/** PNG: signature, IHDR first, every chunk's CRC right, IEND last and exactly at the end. */
function validPng(b: Uint8Array): boolean {
  if (!startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return false;
  let i = 8;
  let first = true;
  while (i + 12 <= b.length) {
    const len = u32be(b, i);
    const typeStart = i + 4;
    const dataEnd = typeStart + 4 + len;
    if (len > 0x7fffffff || dataEnd + 4 > b.length) return false;
    for (let k = typeStart; k < typeStart + 4; k++) {
      const c = b[k];
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return false;
    }
    const type = String.fromCharCode(b[typeStart], b[typeStart + 1], b[typeStart + 2], b[typeStart + 3]);
    if (first && type !== "IHDR") return false;
    first = false;
    if (crc32(b, typeStart, dataEnd) !== u32be(b, dataEnd)) return false;
    i = dataEnd + 4;
    if (type === "IEND") return len === 0 && i === b.length;
  }
  return false;
}

/** JPEG: SOI, marker segments with in-bounds lengths, entropy data after SOS, EOI exactly at the end. */
function validJpeg(b: Uint8Array): boolean {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return false;
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return false;
    while (i < b.length && b[i] === 0xff) i++; // fill bytes
    if (i >= b.length) return false;
    const m = b[i++];
    if (m === 0xd9) return i === b.length; // EOI
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue; // standalone markers
    if (m === 0x00 || m === 0xd8) return false;
    if (i + 2 > b.length) return false;
    const len = (b[i] << 8) | b[i + 1];
    if (len < 2 || i + len > b.length) return false;
    i += len;
    if (m === 0xda) {
      // Entropy-coded data: runs until a marker other than a stuffed 00 or a restart marker.
      while (i + 1 < b.length) {
        if (b[i] === 0xff && b[i + 1] !== 0x00 && !(b[i + 1] >= 0xd0 && b[i + 1] <= 0xd7)) break;
        i++;
      }
      if (i + 1 >= b.length) return false;
    }
  }
  return false;
}

/** GIF: header, logical screen, every extension and image block walked, trailer exactly at the end. */
function validGif(b: Uint8Array): boolean {
  if (!(startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a"))) || b.length < 14) return false;
  let i = 13;
  const flags = b[10];
  if (flags & 0x80) i += 3 * (1 << ((flags & 0x07) + 1));
  const subBlocks = (): boolean => {
    while (i < b.length) {
      const n = b[i++];
      if (n === 0) return true;
      i += n;
    }
    return false;
  };
  while (i < b.length) {
    const tag = b[i++];
    if (tag === 0x3b) return i === b.length;
    if (tag === 0x21) {
      if (i >= b.length) return false;
      i++; // label
      if (!subBlocks()) return false;
    } else if (tag === 0x2c) {
      if (i + 9 > b.length) return false;
      const f = b[i + 8];
      i += 9;
      if (f & 0x80) i += 3 * (1 << ((f & 0x07) + 1));
      if (i >= b.length) return false;
      i++; // LZW minimum code size
      if (!subBlocks()) return false;
    } else {
      return false;
    }
  }
  return false;
}

/** WebP: RIFF size equal to the file, WEBP form, chunks (even padded) that end exactly at the end. */
function validWebp(b: Uint8Array): boolean {
  if (b.length < 20 || !startsWith(b, ascii("RIFF")) || !startsWith(b.subarray(8), ascii("WEBP"))) return false;
  if (u32le(b, 4) + 8 !== b.length) return false;
  let i = 12;
  let chunks = 0;
  while (i < b.length) {
    if (i + 8 > b.length) return false;
    const size = u32le(b, i + 4);
    const next = i + 8 + size + (size & 1);
    if (next > b.length) return false;
    i = next;
    chunks++;
  }
  return chunks > 0 && i === b.length;
}

/** The media types whose payload may pass, each with its whole-file validator. A Map: no inherited keys. */
export const MEDIA_VALIDATORS: ReadonlyMap<string, (b: Uint8Array) => boolean> = new Map([
  ["image/png", validPng],
  ["image/jpeg", validJpeg],
  ["image/gif", validGif],
  ["image/webp", validWebp],
]);

/** The decoded image when the payload passes every structural check, else null. */
export function validImage(mediaType: unknown, data: unknown): Uint8Array | null {
  if (typeof mediaType !== "string" || typeof data !== "string") return null;
  const validator = MEDIA_VALIDATORS.get(mediaType);
  if (validator === undefined) return null;
  const bytes = decodeBase64Strict(data);
  if (bytes === null) return null;
  return validator(bytes) === true ? bytes : null;
}

/**
 * True when a secret appears in the image. The caller withholds the result.
 *   - named values (8+ chars): in the decoded bytes (read as Latin-1, so text
 *     in a PNG tEXt chunk or EXIF is seen) or in the base64 text itself;
 *   - vendor shapes (sk-ant-, AKIA, PEM header, ...): in the decoded bytes
 *     only. In the base64 text a 4-letter shape such as AKIA occurs by chance
 *     in about 2 % of large images, which would withhold ordinary screenshots.
 */
export function holdsSecret(
  bytes: Uint8Array,
  base64: string,
  named: readonly string[],
  shapes: readonly string[],
): boolean {
  if (named.length === 0 && shapes.length === 0) return false;
  let text = "";
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    text += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  if (named.some((n) => n.length > 0 && (text.includes(n) || base64.includes(n)))) return true;
  return shapes.some((s) => s.length > 0 && text.includes(s));
}
