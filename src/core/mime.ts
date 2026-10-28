/** 媒体类型推断与 EPUB 核心媒体类型判定。 */

const EXT_MIME: Record<string, string> = {
  xhtml: "application/xhtml+xml",
  html: "application/xhtml+xml",
  htm: "application/xhtml+xml",
  css: "text/css",
  js: "text/javascript",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  avif: "image/avif",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  ogv: "video/ogg",
  webm: "video/webm",
  m4a: "audio/mp4",
  wav: "audio/wav",
  opus: "audio/ogg",
  vtt: "text/vtt",
  opf: "application/oebps-package+xml",
  ncx: "application/x-dtbncx+xml",
  xml: "application/xml",
  json: "application/json",
  txt: "text/plain",
  smil: "application/smil+xml",
};

/** 按扩展名猜媒体类型；猜不到时返回传入的默认值或 application/octet-stream。 */
export function guessMediaType(path: string, fallback = "application/octet-stream"): string {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  if (!m) return fallback;
  return EXT_MIME[m[1].toLowerCase()] ?? fallback;
}

/** EPUB 2 核心媒体类型（阅读器必须支持）。 */
export const EPUB2_CORE_TYPES = new Set([
  "application/xhtml+xml",
  "text/css",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "application/x-dtbncx+xml",
]);

/** EPUB 3 核心媒体类型（阅读器必须支持）。 */
export const EPUB3_CORE_TYPES = new Set([
  "application/xhtml+xml",
  "text/css",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "application/javascript",
  "text/javascript",
  "text/html",
  "font/ttf",
  "font/otf",
  "font/woff",
  "font/woff2",
  "audio/mpeg",
  "audio/mp4",
  "video/mp4",
  "application/x-dtbncx+xml",
]);

export function isFontMediaType(mt: string): boolean {
  return (
    mt === "font/ttf" ||
    mt === "font/otf" ||
    mt === "font/woff" ||
    mt === "font/woff2" ||
    mt === "application/vnd.ms-opentype" ||
    mt === "application/x-font-ttf" ||
    mt === "application/x-font-opentype" ||
    mt === "application/x-font-truetype" ||
    mt === "application/x-font-woff" ||
    // 旧版 IDPF 媒体类型（epubcheck 兼容，测试套件在用）
    mt === "application/font-woff" ||
    mt === "application/font-otf" ||
    mt === "application/font-sfnt"
  );
}
