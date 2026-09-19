import { invoke } from "@tauri-apps/api/core";
import { getAppBuildSession, isAiDevelopmentActionsAllowed } from "../../../config/appBuildSession";

/** Exercises host locking in a dedicated namespace; never touches a model. */
export async function probeModelLocks(): Promise<string> {
  if (!isAiDevelopmentActionsAllowed()) throw new Error("模型锁自检仅在 AI 调试版可用");
  if (getAppBuildSession()?.source === "desktop") {
    await invoke("ai_model_lock_probe");
    return "原生文件锁自检通过：共享读取、写入拒绝、释放后写入。未加载模型；跨进程与强制退出另行验收。";
  }
  if (!navigator.locks) throw new Error("此浏览器不支持 Web Locks，请使用 localhost 下的现代浏览器");
  const name = `epub-reader-model-lock-probe:${crypto.randomUUID()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  let release!: () => void;
  const lifetime = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  let failed!: (reason: unknown) => void;
  const acquired = new Promise<void>((resolve, reject) => { entered = resolve; failed = reject; });
  const holder = navigator.locks.request(name, { mode: "shared", signal: controller.signal }, async () => {
    entered();
    await lifetime;
  });
  void holder.catch(failed);
  try {
    await acquired;
    const shared = await navigator.locks.request(name, { mode: "shared", ifAvailable: true }, (lock) => !!lock);
    const blocked = await navigator.locks.request(name, { mode: "exclusive", ifAvailable: true }, (lock) => !lock);
    if (!shared || !blocked) throw new Error("浏览器锁自检失败：共享读取或写入保护不符合预期");
  } finally {
    release();
    clearTimeout(timer);
    await holder;
  }
  const released = await navigator.locks.request(name, { mode: "exclusive", ifAvailable: true }, (lock) => !!lock);
  if (!released) throw new Error("浏览器锁自检失败：占用未释放");
  return "浏览器锁自检通过：共享读取、写入拒绝、释放后写入。仅验证 Web Locks，不保护或验证桌面模型文件。";
}
