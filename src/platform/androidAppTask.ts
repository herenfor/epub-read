import { addPluginListener, invoke, type PluginListener } from "@tauri-apps/api/core";

/** 书架“再返回一次退出”：交给系统退到后台（与 Android 12+ 根页面返回一致）。 */
export async function moveAndroidTaskToBack(): Promise<void> {
  await invoke("android_move_task_to_back");
}

/** Subscribe before reading the snapshot so a transition cannot be missed. */
export function watchAndroidForeground(onChange: (foreground: boolean) => void): () => void {
  let closed = false;
  let receivedEvent = false;
  let listener: PluginListener | undefined;
  void (async () => {
    try {
      listener = await addPluginListener<{ foreground: boolean }>("androidAppTask", "foreground", ({ foreground }) => {
        receivedEvent = true;
        if (!closed) onChange(foreground);
      });
      if (closed) {
        await listener.unregister();
        return;
      }
      const { foreground } = await invoke<{ foreground: boolean }>("android_app_foreground");
      if (!closed && !receivedEvent) onChange(foreground);
    } catch (error) {
      // Keep speculative reads paused if the native state is unavailable.
      if (!closed) console.warn("Android foreground subscription failed", error);
    }
  })();
  return () => {
    closed = true;
    void listener?.unregister().catch(() => undefined);
  };
}
