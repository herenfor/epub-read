/** Only native text-editing menus are allowed; application menus handle their own events. */
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number"]);

export function allowsNativeEditMenu(target: EventTarget | null): boolean {
  const node = target as Node | null;
  const element = node?.nodeType === 1 ? node as Element : node?.parentElement;
  const editor = element?.closest("input, textarea, [contenteditable]");
  if (!editor || editor.matches(":disabled")) return false;
  if (editor.tagName === "TEXTAREA") return true;
  if (editor.tagName === "INPUT") {
    return TEXT_INPUT_TYPES.has((editor.getAttribute("type") ?? "text").toLowerCase());
  }
  const editable = editor.getAttribute("contenteditable")?.toLowerCase();
  return editable === "" || editable === "true" || editable === "plaintext-only";
}

/** Cancel the browser default without stopping the app's book/folder/selection handlers. */
export function applyBrowserContextMenuPolicy(event: Event): boolean {
  const nativeEdit = allowsNativeEditMenu(event.target);
  if (!nativeEdit) event.preventDefault();
  return nativeEdit;
}

/** One listener for the host document, including menus portalled outside the app root. */
export function installBrowserContextMenuPolicy(doc: Document): () => void {
  doc.addEventListener("contextmenu", applyBrowserContextMenuPolicy, true);
  return () => doc.removeEventListener("contextmenu", applyBrowserContextMenuPolicy, true);
}
