import { useContext, useSyncExternalStore, type CSSProperties } from "react";
import { useUiText } from "./localization/UiLanguageProvider";
import { EdgeTurnFeedbackContext, useEdgeTurnFeedbackOwner, type EdgeTurnDirection } from "./edgeTurnFeedback";
import type { EdgeTurnRegion, TapRegionSide } from "./readerTapRegions";
import "./readerTapRegions.css";

interface Props {
  /** Turn a tap executes; the label and arrow follow it. */
  direction: EdgeTurnDirection;
  onTurn(direction: EdgeTurnDirection): void;
  onPrepare?(): void;
  /** Physical side. Omitted: the side matching `direction` (the original layout). */
  side?: TapRegionSide;
  /** Measured band from readerTapRegions; omitted keeps the stylesheet size, width 0 removes the zone. */
  region?: EdgeTurnRegion;
}

/** Click feedback survives host replacement, independent of motion readiness. */
export function EdgeTurnZone({ direction, onTurn, onPrepare, side, region }: Props) {
  const shared = useContext(EdgeTurnFeedbackContext);
  const own = useEdgeTurnFeedbackOwner();
  const feedback = shared ?? own;
  const physical = side ?? (direction === -1 ? "left" : "right");
  // Feedback belongs to the band that was tapped, whatever it executes.
  const feedbackKey: EdgeTurnDirection = physical === "left" ? -1 : 1;
  const holding = useSyncExternalStore(feedback.subscribe, () => feedback.holding(feedbackKey), () => false);

  const { t } = useUiText();
  if (region && region.width <= 0) return null;
  const label = t(direction === -1 ? "readerMisc.edge.prev" : "readerMisc.edge.next");
  // edge-turn-prev/next also position the zone, so they only appear where they match the physical side.
  const natural = (physical === "left") === (direction === -1);
  const extended = side !== undefined || region !== undefined;
  const className = ["edge-turn-zone",
    natural ? (direction === -1 ? "edge-turn-prev" : "edge-turn-next") : null,
    extended ? `edge-turn-${physical}` : null,
    holding ? "is-holding" : null].filter(Boolean).join(" ");
  const style = region ? {
    width: region.width, minWidth: 0, maxWidth: "none",
    "--edge-turn-arrow-center": `${region.arrowCenter}px`,
  } as CSSProperties : undefined;
  return <div
    className={className} style={style}
    data-edge-side={extended ? physical : undefined}
    data-edge-action={extended ? (direction === -1 ? "prev" : "next") : undefined}
    data-edge-region={region ? "" : undefined}
    title={label} aria-label={label}
    onPointerDown={() => onPrepare?.()}
    onClick={(event) => { event.stopPropagation(); feedback.hold(feedbackKey); onTurn(direction); }}
  >
    {/* The chevron points at its own edge; what the tap does (next / previous,
        right-to-left books, "left also forward") is in the label, not the glyph. */}
    <button type="button" className="edge-turn-arrow" tabIndex={-1} aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points={physical === "left" ? "15 18 9 12 15 6" : "9 18 15 12 9 6"} />
      </svg>
    </button>
  </div>;
}
