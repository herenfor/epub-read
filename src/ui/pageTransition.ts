import { flushSync } from "react-dom";

export type PageDirection = "forward" | "back";

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void>; updateCallbackDone: Promise<void> };
};

function systemReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Switches full-screen pages through a view transition: the browser draws the
 * new page completely, then animates snapshots of the two, so the first paint
 * of the new page never lands inside the animation. `update` runs once, with
 * its React updates committed synchronously; without view transitions (or
 * when the system asks for no motion) it runs at once. Resolves when the new
 * page is in the DOM, not when the animation ends.
 */
export function runPageTransition(direction: PageDirection, update: () => void): Promise<void> {
  const doc = typeof document === "undefined" ? null : document as ViewTransitionDocument;
  if (!doc?.startViewTransition || systemReducedMotion()) {
    update();
    return Promise.resolve();
  }
  const root = doc.documentElement;
  root.dataset.pageTransition = direction;
  const transition = doc.startViewTransition(() => flushSync(update));
  void transition.finished.catch(() => undefined).then(() => {
    if (root.dataset.pageTransition === direction) delete root.dataset.pageTransition;
  });
  return transition.updateCallbackDone;
}
