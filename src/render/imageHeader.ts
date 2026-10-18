export interface ImagePixelSize { width: number; height: number }

function positive(width: number, height: number): ImagePixelSize | null {
  return width > 0 && height > 0 ? { width, height } : null;
}

function ascii(bytes: Uint8Array, at: number, text: string): boolean {
  return at + text.length <= bytes.length && [...text].every((char, i) => bytes[at + i] === char.charCodeAt(0));
}

/** Encoded canvas dimensions only: no decoding, Blob, DOM or retained byte buffers. */
export function imagePixelSize(bytes: Uint8Array): ImagePixelSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 33 && bytes[0] === 0x89 && ascii(bytes, 1, "PNG\r\n\x1a\n")) {
    if (view.getUint32(8) !== 13 || !ascii(bytes, 12, "IHDR")) return null;
    const width = view.getUint32(16), height = view.getUint32(20);
    return width <= 0x7fffffff && height <= 0x7fffffff ? positive(width, height) : null;
  }
  if (bytes.length >= 13 && (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a"))) {
    return positive(view.getUint16(6, true), view.getUint16(8, true));
  }
  if (bytes.length >= 12 && ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) {
    const end = view.getUint32(4, true) + 8;
    if (end > bytes.length || end < 12) return null;
    for (let at = 12; at + 8 <= end;) {
      const size = view.getUint32(at + 4, true);
      const data = at + 8;
      const next = data + size + (size % 2);
      if (next > end) return null;
      if (ascii(bytes, at, "VP8X")) {
        if (size < 10) return null;
        const u24 = (p: number) => bytes[p] + bytes[p + 1] * 256 + bytes[p + 2] * 65536;
        const width = u24(data + 4) + 1, height = u24(data + 7) + 1;
        return width * height <= 0xffffffff ? { width, height } : null;
      }
      if (ascii(bytes, at, "VP8L")) {
        if (size < 5 || bytes[data] !== 0x2f) return null;
        const bits = view.getUint32(data + 1, true);
        if (bits >>> 29) return null;
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      if (ascii(bytes, at, "VP8 ")) {
        if (size < 10 || (bytes[data] & 1) || !ascii(bytes, data + 3, "\x9d\x01\x2a")) return null;
        return positive(view.getUint16(data + 6, true) & 0x3fff, view.getUint16(data + 8, true) & 0x3fff);
      }
      at = next;
    }
    return null;
  }
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at < bytes.length) {
    if (bytes[at++] !== 0xff) return null;
    while (at < bytes.length && bytes[at] === 0xff) at++;
    if (at >= bytes.length) return null;
    const marker = bytes[at++];
    if (marker === 0 || marker === 0xda || marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > bytes.length) return null;
    const size = view.getUint16(at);
    if (size < 2 || at + size > bytes.length) return null;
    // C4=DHT, C8=JPG, CC=DAC are not SOF markers.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (size < 8 || bytes[at + 7] === 0 || size < 8 + 3 * bytes[at + 7]) return null;
      return positive(view.getUint16(at + 5), view.getUint16(at + 3));
    }
    at += size;
  }
  return null;
}
