/** Encoded JPEG/PNG dimensions for a speculative decode estimate. */
export function rasterHeaderSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const dimensions = (width: number, height: number) => width && height ? { width, height } : undefined;
  const header = bytes.subarray(0, 256 * 1024);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (header.length >= 24 &&
      view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a &&
      view.getUint32(8) === 13 && view.getUint32(12) === 0x49484452) {
    return dimensions(view.getUint32(16), view.getUint32(20));
  }

  if (header.length < 4 || view.getUint16(0) !== 0xffd8) return;
  let offset = 2;
  while (offset + 3 < header.length && header[offset++] === 0xff) {
    while (header[offset] === 0xff) offset++;
    if (offset + 2 >= header.length) return;
    const marker = header[offset++];
    if (marker === 0xda || marker === 0xd9) return;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > header.length) return;
    const isFrame = marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (length < 8) return;
      return dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
    }
    offset += length;
  }
}

export function rasterHeaderPixels(bytes: Uint8Array): number | undefined {
  const size = rasterHeaderSize(bytes);
  return size && size.width * size.height;
}
