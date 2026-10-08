import { createContext, useEffect, useState } from "react";

export type EdgeTurnDirection = -1 | 1;
export const EDGE_TURN_HOLD_MS = 400;

/** Owned above chapter/image hosts: replacing a host never restarts its hold. */
export class EdgeTurnFeedback {
  private readonly held = new Map<EdgeTurnDirection, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();

  holding = (direction: EdgeTurnDirection): boolean => this.held.has(direction);

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  hold(direction: EdgeTurnDirection): void {
    const previous = this.held.get(direction);
    if (previous !== undefined) clearTimeout(previous);
    this.held.set(direction, setTimeout(() => {
      this.held.delete(direction);
      this.emit();
    }, EDGE_TURN_HOLD_MS));
    if (previous === undefined) this.emit();
  }

  dispose(): void {
    for (const timer of this.held.values()) clearTimeout(timer);
    this.held.clear();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const EdgeTurnFeedbackContext = createContext<EdgeTurnFeedback | null>(null);

export function useEdgeTurnFeedbackOwner(): EdgeTurnFeedback {
  const [feedback] = useState(() => new EdgeTurnFeedback());
  useEffect(() => () => feedback.dispose(), [feedback]);
  return feedback;
}
