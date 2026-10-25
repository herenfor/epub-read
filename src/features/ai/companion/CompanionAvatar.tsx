import { useEffect, useRef, useState } from "react";
import { Application } from "pixi.js";
import type { Live2DModel } from "pixi-live2d-display/cubism4";
import { applyAvatarEmotion, loadLocalAvatar, type LocalAvatarProfile } from "./avatarModel";

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

/** Local model selection and Cubism runtime stay excluded from Git and all builds. */
export function CompanionAvatar() {
  const host = useRef<HTMLDivElement>(null);
  const activeModel = useRef<Live2DModel | null>(null);
  const [error, setError] = useState("");
  const [profile, setProfile] = useState<LocalAvatarProfile | null>(null);
  const [emotion, setEmotion] = useState("");
  const [changing, setChanging] = useState(false);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let frame = 0;
    let visible = true;
    let model: Live2DModel | undefined;
    let app: Application | undefined;
    const controller = new AbortController();
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
      const selected = await loadLocalAvatar(controller.signal);
      // The Cubism plugin references its runtime during module evaluation.
      await loadCubismCore();
      const { Live2DModel } = await import("pixi-live2d-display/cubism4");
      if (disposed) return;
      app = new Application({ width: 160, height: 170, backgroundAlpha: 0, antialias: true,
        resolution: Math.min(devicePixelRatio, 1.25), autoDensity: true, autoStart: false, sharedTicker: false });
      element.appendChild(app.view);
      const loaded = await Live2DModel.from(selected.modelUrl,
        { autoUpdate: false, autoInteract: false, idleMotionGroup: selected.idleMotionGroup });
      if (disposed) { loaded.destroy({ children: true, texture: true, baseTexture: true }); return; }
      model = loaded; app.stage.addChild(model); fit();
      if (selected.defaultEmotion) await applyAvatarEmotion(model, selected, selected.defaultEmotion);
      if (disposed) return;
      activeModel.current = model;
      setProfile(selected); setEmotion(selected.defaultEmotion);
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
      activeModel.current = null;
      app = undefined;
    });
    return () => {
      disposed = true; controller.abort(); activeModel.current = null;
      cancelAnimationFrame(frame); resize.disconnect(); intersection.disconnect();
      app?.destroy(true, { children: true, texture: true, baseTexture: true }); app = undefined;
    };
  }, []);
  const previewEmotion = async (name: string) => {
    const model = activeModel.current;
    if (!model || !profile) return;
    setChanging(true);
    try {
      await applyAvatarEmotion(model, profile, name);
      if (activeModel.current === model) { setEmotion(name); setError(""); }
    } catch {
      if (activeModel.current === model) setError("表情或动作未能加载");
    } finally {
      if (activeModel.current === model) setChanging(false);
    }
  };
  return <div className="companion-avatar"><div ref={host} role="img" aria-label="Live2D 本地测试形象" />
    <small>{error || (profile ? `${profile.name} · 本机模型` : "正在加载本机模型…")}</small>
    {profile && Object.keys(profile.emotions).length > 0 && <details>
      <summary>表情预览</summary>
      <select aria-label="Live2D 表情预览" value={emotion} disabled={changing}
        onChange={event => { void previewEmotion(event.target.value); }}>
        {Object.entries(profile.emotions).map(([name, definition]) => <option key={name} value={name}>{definition.zh}</option>)}
      </select>
    </details>}</div>;
}
