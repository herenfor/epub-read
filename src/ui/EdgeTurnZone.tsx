import { useContext, useSyncExternalStore } from "react";
import { EdgeTurnFeedbackContext, useEdgeTurnFeedbackOwner, type EdgeTurnDirection } from "./edgeTurnFeedback";

interface Props {
  direction: EdgeTurnDirection;
  onTurn(): void;
  onPrepare?(): void;
}

/** Click feedback survives host replacement, independent of motion readiness. */
export function EdgeTurnZone({ direction, onTurn, onPrepare }: Props) {
  const shared = useContext(EdgeTurnFeedbackContext);
  const own = useEdgeTurnFeedbackOwner();
  const feedback = shared ?? own;
  const holding = useSyncExternalStore(feedback.subscribe, () => feedback.holding(direction), () => false);

  const label = direction === -1 ? "上一页" : "下一页";
  return <div
    className={`edge-turn-zone ${direction === -1 ? "edge-turn-prev" : "edge-turn-next"}${holding ? " is-holding" : ""}`}
    title={label} aria-label={label}
    onPointerDown={() => onPrepare?.()}
    onClick={(event) => { event.stopPropagation(); feedback.hold(direction); onTurn(); }}
  >
    <button type="button" className="edge-turn-arrow" tabIndex={-1} aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points={direction === -1 ? "15 18 9 12 15 6" : "9 18 15 12 9 6"} />
      </svg>
    </button>
  </div>;
}
