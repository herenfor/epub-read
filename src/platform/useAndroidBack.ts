import { useEffect, useRef } from "react";
import { onBackButtonPress } from "@tauri-apps/api/app";

/**
 * Registers the Tauri Android Back listener only while the app has something
 * to consume. When disabled, AppPlugin falls back to the Android default:
 * WebView history first, then Activity finish.
 */
export function useAndroidBack(enabled: boolean, handler: () => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void onBackButtonPress(() => {
      handlerRef.current();
    })
      .then((listener) => {
        if (disposed) {
          void listener.unregister();
          return;
        }
        unlisten = () => {
          void listener.unregister();
        };
      })
      .catch(() => {
        // Native Back may still work without the listener; do not break the app.
      });

    return () => {
      disposed = true;
      unlisten?.();
      unlisten = null;
    };
  }, [enabled]);
}
