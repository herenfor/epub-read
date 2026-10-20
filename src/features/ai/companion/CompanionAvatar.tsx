import { useEffect, useRef, useState } from "react";
import { Application } from "pixi.js";
import type { Live2DModel } from "pixi-live2d-display/cubism4";

let coreReady: Promise<void> | undefined;
function loadCubismCore(): Promise<void> {
  return coreReady ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/__ai-companion/live2dcubismcore.min.js";
    script.onload = () => resolve();
    script.onerror = () => { coreReady = undefined; script.remove(); reject(new Error("Missing local Cubism Core")); };
    document.head.appendChild(script);
  });
}

/** Local AIRI Hiyori sample. Its Cubism runtime and model are excluded from Git and all builds. */
export function CompanionAvatar() {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let frame = 0;
    let visible = true;
    let model: Live2DModel | undefined;
    let app: Application | undefined;
    const fit = () => {
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height || !app) return;
      app.renderer.resize(width, height);
      if (model) {
        model.scale.set(Math.min(width / model.internalModel.width, height / model.internalModel.height));
        model.anchor.set(0.5, 1);
        model.position.set(width / 2, height);
      }
    };
    const resize = new ResizeObserver(fit);
    resize.observe(element);
    const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
    intersection.observe(element);
    void (async () => {
      // The Cubism plugin references its runtime during module evaluation.
      await loadCubismCore();
      const { Live2DModel } = await import("pixi-live2d-display/cubism4");
      if (disposed) return;
      app = new Application({ width: 160, height: 170, backgroundAlpha: 0, antialias: true,
        resolution: Math.min(devicePixelRatio, 1.25), autoDensity: true, autoStart: false, sharedTicker: false });
      element.appendChild(app.view);
      const loaded = await Live2DModel.from("/__ai-companion/hiyori_free_zh/runtime/hiyori_free_t08.model3.json",
        { autoUpdate: false, autoInteract: false });
      if (disposed) { loaded.destroy({ children: true, texture: true, baseTexture: true }); return; }
      model = loaded; app.stage.addChild(model); fit();
      let previous = performance.now();
      const render = (now: number) => {
        frame = requestAnimationFrame(render);
        if (document.hidden || !visible) { previous = now; return; }
        if (now - previous < 1000 / 30) return;
        model!.update(Math.min(now - previous, 50)); previous = now;
        app!.render();
      };
      frame = requestAnimationFrame(render);
    })().catch(() => {
      if (!disposed) setError("本机 Live2D 素材未就绪；对话仍可使用");
      app?.destroy(true, { children: true, texture: true, baseTexture: true });
      app = undefined;
    });
    return () => {
      disposed = true; cancelAnimationFrame(frame); resize.disconnect(); intersection.disconnect();
      app?.destroy(true, { children: true, texture: true, baseTexture: true }); app = undefined;
    };
  }, []);
  return <div className="companion-avatar"><div ref={host} role="img" aria-label="Live2D 本地测试形象" />
    <small>{error || "Hiyori FREE · Live2D Inc. · 仅本机测试"}</small></div>;
}
