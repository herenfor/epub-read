import { useEffect, useRef, useState } from "react";

type Size = { width: number; height: number };
type Props = {
  url: string;
  alt: string;
  target?: Size;
  zoomed: boolean;
  onReady(size: Size): void;
  onError(): void;
};

/** The display raster and the on-demand original share the same page box. */
export function ComicPageRaster({ url, alt, target, zoomed, onReady, onError }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const ready = useRef(onReady);
  ready.current = onReady;
  const [fallback, setFallback] = useState(false);
  const [originalReady, setOriginalReady] = useState(false);
  const w = target?.width, h = target?.height;
  useEffect(() => {
    if (!w || !h) return;
    const controller = new AbortController();
    void (async () => {
      const blob = await (await fetch(url, { signal: controller.signal })).blob();
      const bitmap = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: "medium" });
      try {
        if (controller.signal.aborted || !canvas.current) return;
        const element = canvas.current;
        const context = element.getContext("2d");
        if (!context) throw new Error("Comic display canvas unavailable");
        element.width = bitmap.width;
        element.height = bitmap.height;
        context.drawImage(bitmap, 0, 0);
        ready.current({ width: bitmap.width, height: bitmap.height });
      } finally {
        bitmap.close();
      }
    })().catch(() => { if (!controller.signal.aborted) setFallback(true); });
    return () => controller.abort();
  }, [url, w, h]);
  useEffect(() => {
    if (!zoomed) setOriginalReady(false);
  }, [zoomed]);

  const useDisplayRaster = !!target && !fallback;
  return <>
    {useDisplayRaster && <canvas ref={canvas} width={w} height={h} role="img" aria-label={alt} hidden={zoomed && originalReady}/>}
    {(!useDisplayRaster || zoomed) && <img src={url} alt={alt} draggable={false} decoding="async"
      hidden={useDisplayRaster && !originalReady}
      onLoad={event => {
        setOriginalReady(true);
        ready.current({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
      }}
      onError={() => { if (!useDisplayRaster) onError(); }}/>}
  </>;
}
