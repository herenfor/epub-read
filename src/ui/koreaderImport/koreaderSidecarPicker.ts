/** System picker for one KOReader sidecar (metadata.epub.lua). */
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { SaveFileLocation } from "../../platform/saveFileNativeBridge";
import { uiText } from "../localization/UiLanguageProvider";

export async function pickKoreaderSidecar(platform: string): Promise<{ source: SaveFileLocation; label: string } | null> {
  if (platform === "android") {
    // Android document pickers do not filter by extension reliably; the native open checks the content.
    const selected = await openFileDialog({ multiple: false, directory: false, title: uiText("koreaderImport.picker.title") });
    const uri = Array.isArray(selected) ? selected[0] : selected;
    if (typeof uri !== "string" || uri.length === 0) return null;
    return { source: { kind: "uri", uri }, label: decodeURIComponent(uri.split("/").pop() ?? "") || "metadata.epub.lua" };
  }
  const selected = await openFileDialog({
    multiple: false,
    directory: false,
    title: uiText("koreaderImport.picker.title"),
    filters: [{ name: uiText("koreaderImport.picker.filter"), extensions: ["lua"] }],
  });
  const path = Array.isArray(selected) ? selected[0] : selected;
  if (typeof path !== "string" || path.length === 0) return null;
  return { source: { kind: "path", path }, label: path.split(/[\\/]/).pop() || path };
}
