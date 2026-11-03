import { useEffect, useRef, useState } from "react";

type Size = { width: number; height: number };
type Props = {
  url: string;
  blob: Blob;
  alt: string;
  targetHeight?: number;
  zoomed: boolean;
  onReady(size: Size): void;
  onError(): void;
  /** The element left the page; its decode no longer counts. */
  onGone(): void;
};

/** The display raster and the on-demand original share the same page box. */
export function ComicPageRaster({ url, blob, alt, targetHeight, zoomed, onReady, onError, onGone }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const ready = useRef(onReady), gone = useRef(onGone);
  ready.current = onReady;
  gone.current = onGone;
  useEffect(() => () => gone.current(), []);
  const [fallback, setFallback] = useState(false);
  const [originalReady, setOriginalReady] = useState(false);
  useEffect(() => {
    if (!targetHeight) return;
    const controller = new AbortController();
    void (async () => {
      // A single resize dimension preserves the decoder's orientation-aware aspect ratio.
      const bitmap = await createImageBitmap(blob, { resizeHeight: targetHeight, resizeQuality: "medium" });
      try {
        if (controller.signal.aborted || !canvas.current) return;
        const element = canvas.current;
        const size = { width: bitmap.width, height: bitmap.height };
        element.width = size.width;
        element.height = size.height;
        const transfer = element.getContext("bitmaprenderer");
        if (transfer) {
          transfer.transferFromImageBitmap(bitmap);
        } else {
          const context = element.getContext("2d");
          if (!context) throw new Error("Comic display canvas unavailable");
          context.drawImage(bitmap, 0, 0);
        }
        ready.current(size);
      } finally {
        bitmap.close();
      }
    })().catch(() => { if (!controller.signal.aborted) setFallback(true); });
    return () => controller.abort();
  }, [blob, targetHeight]);
  useEffect(() => {
    if (!zoomed) setOriginalReady(false);
  }, [zoomed]);

  const useDisplayRaster = !!targetHeight && !fallback;
  return <>
    {useDisplayRaster && <canvas ref={canvas} role="img" aria-label={alt} hidden={zoomed && originalReady}/>}
    {(!useDisplayRaster || zoomed) && <img src={url} alt={alt} draggable={false} decoding="async"
      hidden={useDisplayRaster && !originalReady}
      onLoad={event => {
        setOriginalReady(true);
        ready.current({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
      }}
      onError={() => { if (!useDisplayRaster) onError(); }}/>}
  </>;
}
