import { useEffect, useRef, type RefObject } from "react";

/**
 * While a range slider inside `rootRef` is held, the panel gives the page
 * back: `data-slider-focus` on the root hides the panel and every row but
 * the held one (`data-slider-focused`, the closest `[data-slider-row]` or
 * display-page range row), so
 * the text behind shows each change. Attributes are written directly, so a
 * drag re-renders nothing; only `onChange` hears the row key, on press and
 * on release.
 */
export function useSliderFocus(
  rootRef: RefObject<HTMLElement>,
  onChange?: (row: string | null) => void,
): void {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let row: HTMLElement | null = null;
    const end = (): void => {
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      window.removeEventListener("blur", end);
      if (!row) return;
      row.removeAttribute("data-slider-focused");
      root.removeAttribute("data-slider-focus");
      row = null;
      onChangeRef.current?.(null);
    };
    const down = (event: PointerEvent): void => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      const input = (event.target as Element | null)?.closest?.('input[type="range"]');
      if (!input || !root.contains(input) || (input as HTMLInputElement).disabled) return;
      end();
      row = (input.closest("[data-slider-row], .rd-range-row") as HTMLElement | null) ?? input.parentElement;
      if (!row) return;
      const key = row.getAttribute("data-slider-row") ?? "";
      row.setAttribute("data-slider-focused", "");
      root.setAttribute("data-slider-focus", key);
      window.addEventListener("pointerup", end, true);
      window.addEventListener("pointercancel", end, true);
      window.addEventListener("blur", end);
      onChangeRef.current?.(key);
    };
    root.addEventListener("pointerdown", down);
    return () => {
      root.removeEventListener("pointerdown", down);
      end();
    };
  }, [rootRef]);
}
