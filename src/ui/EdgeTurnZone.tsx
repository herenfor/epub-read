import { useEffect, useRef, useState } from "react";

interface Props {
  direction: -1 | 1;
  onTurn(): void;
  onPrepare?(): void;
}

/** Feedback is local to the edge, independent of navigation/motion readiness. */
export function EdgeTurnZone({ direction, onTurn, onPrepare }: Props) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
    }, 400);
  };
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  const label = direction === -1 ? "上一页" : "下一页";
  return <div
    className={`edge-turn-zone ${direction === -1 ? "edge-turn-prev" : "edge-turn-next"}${holding ? " is-holding" : ""}`}
    title={label} aria-label={label}
    onPointerEnter={(event) => { if (event.pointerType === "mouse") show(); }}
    onPointerDown={() => { show(); onPrepare?.(); }}
    onClick={(event) => { event.stopPropagation(); show(); onTurn(); }}
  >
    <button type="button" className="edge-turn-arrow" tabIndex={-1} aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points={direction === -1 ? "15 18 9 12 15 6" : "9 18 15 12 9 6"} />
      </svg>
    </button>
  </div>;
}
