/**
 * Reading interactions that cloud sync should not compete with: finger
 * drags, page-turn animations and slider drags each hold a token while they
 * run. Only the busy/idle edges reach the listener, never individual frames
 * or scroll events. Leaf module: no imports, safe for render code.
 */

let holders = 0;
let listener: ((busy: boolean) => void) | null = null;

/** Marks one interaction as running; call the returned function once when it ends, is cancelled or unmounts. */
export function holdInteractionBusy(): () => void {
  holders += 1;
  if (holders === 1) listener?.(true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders === 0) listener?.(false);
  };
}

export function interactionBusy(): boolean {
  return holders > 0;
}

/** One listener (the cloud sync store); returns the matching removal. */
export function onInteractionBusyChange(next: (busy: boolean) => void): () => void {
  listener = next;
  return () => {
    if (listener === next) listener = null;
  };
}
