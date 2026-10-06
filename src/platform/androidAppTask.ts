import { invoke } from "@tauri-apps/api/core";

/** 书架“再返回一次退出”：交给系统退到后台（与 Android 12+ 根页面返回一致）。 */
export async function moveAndroidTaskToBack(): Promise<void> {
  await invoke("android_move_task_to_back");
}
