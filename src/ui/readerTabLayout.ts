import { useSyncExternalStore } from "react";

/** Desktop windows keep tabs; touch needs a landscape tablet-sized reading area. */
export function readerTabsFitViewport(touch: boolean, width: number, height: number): boolean {
  return !touch || (width >= 840 && height >= 600 && width > height);
}

function subscribeResize(listener: () => void): () => void {
  window.addEventListener("resize", listener, { passive: true });
  return () => window.removeEventListener("resize", listener);
}

function touchLayoutSnapshot(): boolean {
  return readerTabsFitViewport(true, window.innerWidth, window.innerHeight);
}

const serverSnapshot = () => false;

/** Only a change of eligibility rerenders the host, not every pixel of a resize. */
export function useReaderTabsVisible(touch: boolean): boolean {
  const touchFits = useSyncExternalStore(subscribeResize, touchLayoutSnapshot, serverSnapshot);
  return !touch || touchFits;
}
