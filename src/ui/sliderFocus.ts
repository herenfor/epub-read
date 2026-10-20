import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { SliderDragHost } from "./TouchSlider";

/**
 * While a slider inside `rootRef` drags, the panel gives the page back:
 * `data-slider-focus` on the root hides the panel and every row but the held
 * one (`data-slider-focused`), so the text behind shows each change. The
 * attributes are written directly, so a drag re-renders nothing; `onChange`
 * hears the row key when a drag begins and null when it ends.
 *
 * Every way out ends through the same path: the drag's own release (only
 * with its token, so a stale release cannot end a newer drag), and the
 * panel going inactive or unmounting. A drag cut off that way stops
 * changing the setting even if its finger is still down.
 */
export function useSliderFocus(
  rootRef: RefObject<HTMLElement>,
  onChange?: (row: string | null) => void,
  active = true,
): SliderDragHost {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const current = useRef<{ token: number; row: HTMLElement | null }>({ token: 0, row: null });
  const host = useMemo(() => {
    const release = (): boolean => {
      const { row } = current.current;
      if (!row) return false;
      row.removeAttribute("data-slider-focused");
      rootRef.current?.removeAttribute("data-slider-focus");
      current.current = { token: current.current.token, row: null };
      return true;
    };
    return {
      begin(row: HTMLElement, key: string): number {
        if (release()) onChangeRef.current?.(null);
        const token = current.current.token + 1;
        current.current = { token, row };
        row.setAttribute("data-slider-focused", "");
        rootRef.current?.setAttribute("data-slider-focus", key);
        onChangeRef.current?.(key);
        return token;
      },
      end(token: number): void {
        if (token !== current.current.token) return;
        if (release()) onChangeRef.current?.(null);
      },
      alive(token: number): boolean {
        return token === current.current.token && current.current.row !== null;
      },
      endAll(): void {
        if (release()) onChangeRef.current?.(null);
      },
    };
  }, [rootRef]);
  useEffect(() => {
    if (!active) host.endAll();
  }, [active, host]);
  useEffect(() => () => host.endAll(), [host]);
  return host;
}
