import { useState } from "react";
import { getAppBuildSession } from "../../../config/appBuildSession";
import { probeModelLocks } from "../models/modelLockProbe";

export function ModelLockSection() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const desktop = getAppBuildSession()?.source === "desktop";
  const check = async () => {
    setBusy(true);
    setMessage("检查中…");
    try { setMessage(await probeModelLocks()); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return (
    <section className="model-assets-development" aria-label="共享模型库保护">
      <h3>共享模型库保护</h3>
      <p className="model-assets-note">{desktop
        ? "下载、校验和删除现已使用文件锁。先在下方选择模型库，再检查共享读取与写入保护；不会加载或删除模型。"
        : "浏览器可检查标签页锁的读写互斥与释放。桌面模型库的文件锁需在 Windows 验证。"}</p>
      <div className="model-assets-actions">
        <button disabled={busy} onClick={() => void check()}>{desktop ? "检查文件锁" : "检查浏览器锁"}</button>
      </div>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
