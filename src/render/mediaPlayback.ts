import { MEDIA_FRAGMENT, MEDIA_PATH } from "./mediaMarkup";

export interface MediaPlaybackText {
  audio: string;
  video: string;
  loading: string;
  retry: string;
  unavailable: string;
  unsupported: string;
  play: string;
}

export const DEFAULT_MEDIA_PLAYBACK_TEXT: MediaPlaybackText = {
  audio: "Load and play audio", video: "Load and play video", loading: "Loading media…",
  retry: "Media could not be loaded. Tap to retry", unavailable: "No embedded media file found",
  unsupported: "This device cannot play this media format", play: "Tap to play",
};

export interface MediaResourceLease { url: string; release(): void }
export interface MediaResourceSource {
  resourceMediaType(path: string): string | undefined;
  acquireResource(path: string): Promise<MediaResourceLease>;
}

interface Player {
  media: HTMLMediaElement;
  leases: MediaResourceLease[];
  generation: number;
  loading: boolean;
  stop(): void;
}

// A book's paginated, continuous and prepared documents share one playback owner.
// The key is the ResourceServer session; no app-global audio/DOM registry is kept.
const owners = new WeakMap<MediaResourceSource, Player>();

export interface ChapterMediaPlayback {
  stop(): void;
  stopIfOutsideViewport(): void;
  dispose(): void;
}

function isVisible(media: HTMLMediaElement): boolean {
  let rect = media.getBoundingClientRect();
  let doc = media.ownerDocument;
  while (true) {
    const win = doc.defaultView;
    if (!win || doc.visibilityState === "hidden") return false;
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= win.innerWidth || rect.top >= win.innerHeight) return false;
    const frame = win.frameElement as HTMLElement | null;
    if (!frame) return true;
    const parentWin = frame.ownerDocument.defaultView;
    const style = parentWin?.getComputedStyle(frame);
    if (style?.visibility === "hidden" || style?.display === "none") return false;
    const box = frame.getBoundingClientRect();
    rect = { left: box.left + Math.max(0, rect.left), top: box.top + Math.max(0, rect.top),
      right: box.left + Math.min(win.innerWidth, rect.right), bottom: box.top + Math.min(win.innerHeight, rect.bottom) } as DOMRect;
    doc = frame.ownerDocument;
  }
}

/** Book scripts remain disabled. Reader-owned code only prepares native media controls. */
export function installChapterMediaPlayback(
  doc: Document,
  source: MediaResourceSource,
  options: { text?: () => MediaPlaybackText; onMetadata?: () => void } = {},
): ChapterMediaPlayback {
  const elements = doc.querySelectorAll<HTMLMediaElement>("audio,video");
  if (!elements.length) return { stop: noop, stopIfOutsideViewport: noop, dispose: noop };
  const text = options.text ?? (() => DEFAULT_MEDIA_PLAYBACK_TEXT);
  const cleanups: Array<() => void> = [];
  let disposed = false;
  let active: Player | null = null;
  const stop = () => { active?.stop(); };
  const stopIfOutsideViewport = () => {
    if (active && !isVisible(active.media)) active.stop();
  };
  const win = doc.defaultView;
  const observer = win?.IntersectionObserver ? new win.IntersectionObserver(stopIfOutsideViewport) : null;

  for (const media of elements) {
    const host = doc.createElement("span");
    host.setAttribute("data-reader-media-player", "");
    media.before(host);
    host.appendChild(media);
    const button = doc.createElement("button");
    button.type = "button";
    button.setAttribute("data-reader-media-start", "");
    // Labels are CSS-generated from aria-label, never chapter text. Adding UI
    // must not shift canonical search/note/bookmark text offsets.
    button.setAttribute("aria-label", media.localName === "audio" ? text().audio : text().video);
    host.appendChild(button);
    const tracks = Array.from(media.querySelectorAll<HTMLTrackElement>(`track[${MEDIA_PATH}]`));
    const candidates = media.hasAttribute(MEDIA_PATH) ? [media]
      : Array.from(media.querySelectorAll<HTMLSourceElement>(`source[${MEDIA_PATH}]`));
    const player: Player = {
      media, leases: [], generation: 0, loading: false,
      stop() {
        player.generation++;
        player.loading = false;
        media.pause();
        media.removeAttribute("src");
        for (const track of tracks) track.removeAttribute("src");
        media.load();
        // Detach decoder/URLs before returning the bytes to the book LRU.
        for (const lease of player.leases.splice(0)) lease.release();
        if (owners.get(source) === player) owners.delete(source);
        if (active === player) active = null;
        button.disabled = false;
        button.hidden = false;
        button.setAttribute("aria-label", media.localName === "audio" ? text().audio : text().video);
      },
    };
    observer?.observe(host);
    const claim = () => {
      const previous = owners.get(source);
      if (previous && previous !== player) previous.stop();
      owners.set(source, player);
      active = player;
    };
    const start = async () => {
      if (disposed || player.loading || !isVisible(media)) return;
      claim();
      const generation = ++player.generation;
      const current = () => !disposed && player.generation === generation;
      try {
        if (!player.leases.length) {
          const existing = candidates.filter(candidate => source.resourceMediaType(candidate.getAttribute(MEDIA_PATH)!) !== undefined);
          const candidate = existing.find(candidate => {
            const type = candidate.getAttribute("type") || source.resourceMediaType(candidate.getAttribute(MEDIA_PATH)!);
            return !type || type === "application/octet-stream" || media.canPlayType(type) !== "";
          });
          if (!candidate) {
            if (owners.get(source) === player) owners.delete(source);
            if (active === player) active = null;
            button.setAttribute("aria-label", existing.length ? text().unsupported : text().unavailable);
            return;
          }
          player.loading = true;
          button.disabled = true;
          button.setAttribute("aria-label", text().loading);
          const lease = await source.acquireResource(candidate.getAttribute(MEDIA_PATH)!);
          if (!current()) { lease.release(); return; }
          player.leases.push(lease);
          media.src = lease.url + (candidate.getAttribute(MEDIA_FRAGMENT) ? `#${candidate.getAttribute(MEDIA_FRAGMENT)}` : "");
          // Missing optional subtitles must not prevent otherwise valid playback.
          for (const track of tracks) {
            if (!current()) return;
            const path = track.getAttribute(MEDIA_PATH)!;
            if (source.resourceMediaType(path) === undefined) continue;
            try {
              const trackLease = await source.acquireResource(path);
              if (!current()) { trackLease.release(); return; }
              player.leases.push(trackLease);
              track.src = trackLease.url;
            } catch { /* The media remains usable without an unreadable subtitle. */ }
          }
        }
        if (!current()) return;
        if (!isVisible(media)) { player.stop(); return; }
        player.loading = false;
        button.disabled = false;
        button.hidden = true;
        await media.play();
      } catch (error) {
        if (!current()) return;
        const denied = (error as { name?: string })?.name === "NotAllowedError";
        if (!denied) player.stop();
        player.loading = false;
        button.disabled = false;
        button.hidden = false;
        button.setAttribute("aria-label", denied ? text().play : text().retry);
      }
    };
    const onStart = () => { void start(); };
    const onPlay = () => { if (!isVisible(media)) player.stop(); else claim(); };
    const onError = () => {
      if (!media.error || !player.leases.length) return;
      player.stop();
      button.setAttribute("aria-label", text().unsupported);
    };
    button.addEventListener("click", onStart);
    media.addEventListener("play", onPlay);
    media.addEventListener("error", onError);
    media.addEventListener("loadedmetadata", options.onMetadata ?? noop);
    cleanups.push(() => {
      button.removeEventListener("click", onStart);
      media.removeEventListener("play", onPlay);
      media.removeEventListener("error", onError);
      media.removeEventListener("loadedmetadata", options.onMetadata ?? noop);
    });
  }

  // A preloaded document never requests bytes or plays. These listeners exist
  // only in chapters containing media, with no per-frame work or polling.
  const topDoc = doc.defaultView?.top?.document;
  const onVisibility = () => { if (doc.visibilityState === "hidden" || topDoc?.visibilityState === "hidden") stop(); };
  if (elements.length) {
    doc.addEventListener("visibilitychange", onVisibility);
    if (topDoc && topDoc !== doc) topDoc.addEventListener("visibilitychange", onVisibility);
    win?.addEventListener("pagehide", stop);
  }
  return {
    stop, stopIfOutsideViewport,
    dispose() {
      disposed = true;
      stop();
      observer?.disconnect();
      for (const cleanup of cleanups) cleanup();
      doc.removeEventListener("visibilitychange", onVisibility);
      if (topDoc && topDoc !== doc) topDoc.removeEventListener("visibilitychange", onVisibility);
      win?.removeEventListener("pagehide", stop);
    },
  };
}

const noop = () => {};
