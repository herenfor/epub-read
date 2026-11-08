import { invoke } from "@tauri-apps/api/core";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

/**
 * Where a share card can go on each platform (ER-0119). Desktop copies the
 * image to the clipboard or saves it through the system dialog; Android
 * hands it to the system share sheet or saves it to Photos through the
 * native commands of ER-0120; a plain browser downloads it.
 */

export type ShareSurface = "desktop" | "android" | "browser";
export type ShareActionId = "copyText" | "copyImage" | "saveImage" | "saveGallery" | "share";

/**
 * ER-0120 sets this when `share_image` and `save_image_to_gallery` exist.
 * Both take the PNG as the raw request body (see ipc_bytes.rs) with the
 * percent-encoded headers `x-share-filename` and, for sharing, optional
 * `x-share-text`; `save_image_to_gallery` resolves to `{ uri }`.
 */
export const ANDROID_IMAGE_SHARE_READY = false;

/** The buttons of the panel, left to right; the last one is the main action. */
export function shareActions(surface: ShareSurface, options: { clipboardImage: boolean; androidNative?: boolean }): ShareActionId[] {
  if (surface === "android") {
    return (options.androidNative ?? ANDROID_IMAGE_SHARE_READY) ? ["copyText", "saveGallery", "share"] : ["copyText"];
  }
  return options.clipboardImage ? ["copyText", "copyImage", "saveImage"] : ["copyText", "saveImage"];
}

/** Whether this webview can put a PNG on the clipboard at all. */
export function canCopyImage(): boolean {
  return typeof ClipboardItem !== "undefined" && typeof navigator !== "undefined" && typeof navigator.clipboard?.write === "function";
}

export async function copyShareText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export async function copyShareImage(png: Blob): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

/** A file name like SeLis-呐喊-20261108.png, safe on every file system. */
export function shareFileName(bookTitle: string, date = new Date()): string {
  const safe = bookTitle.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  return safe ? `SeLis-${safe}-${stamp}.png` : `SeLis-${stamp}.png`;
}

/** Saves the card; resolves false when the reader cancels the dialog. */
export async function saveShareImage(png: Blob, fileName: string, surface: ShareSurface, labels: { title: string; filter: string }): Promise<boolean> {
  if (surface === "browser") {
    const url = URL.createObjectURL(png);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  }
  const path = await saveFileDialog({ title: labels.title, defaultPath: fileName, filters: [{ name: labels.filter, extensions: ["png"] }] });
  if (!path) return false;
  await writeFile(path, new Uint8Array(await png.arrayBuffer()));
  return true;
}

export async function saveShareImageToGallery(png: Blob, fileName: string): Promise<void> {
  await invoke("save_image_to_gallery", new Uint8Array(await png.arrayBuffer()), {
    headers: { "x-share-filename": encodeURIComponent(fileName) },
  });
}

export async function shareImageNative(png: Blob, fileName: string, text: string): Promise<void> {
  await invoke("share_image", new Uint8Array(await png.arrayBuffer()), {
    headers: { "x-share-filename": encodeURIComponent(fileName), "x-share-text": encodeURIComponent(text) },
  });
}
