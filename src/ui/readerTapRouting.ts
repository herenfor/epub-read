import { createContext, useContext } from "react";
import type { EdgeTurnDirection, EdgeTurnFeedback } from "./edgeTurnFeedback";
import {
  computeTapRegionGeometry,
  DEFAULT_TAP_REGION_PROFILE,
  tapRegionAction,
  tapRegionAt,
  tapRegionProfileFor,
  type EdgeTurnRegion,
  type PageProgression,
  type ReaderTapPreferences,
  type TapRegionDevice,
  type TapRegionGeometry,
  type TapRegionSide,
} from "./readerTapRegions";

/**
 * Routes body taps of the paged reader through the tap-region geometry.
 *
 * Two entries share one geometry, measured on the presentation host (the
 * box every paged/image-spread host fills):
 * - the transparent EdgeTurnZone bands keep their default size (never the
 *   custom 35%), so links, notes, images and selection under a wide custom
 *   region still receive the event first;
 * - body taps that survived plainTap's filters land here and are classified
 *   by where they fell in the host.
 * A tap on a band never reaches the iframe, and a body tap never reaches a
 * band, so each tap is consumed by exactly one entry.
 */

export interface ReaderTapRegionSettings {
  device: TapRegionDevice;
  preferences: ReaderTapPreferences;
  /** Direction of the open book; settings opened from the shelf have none (left to right). */
  progression?: PageProgression;
}

export interface ReaderTapRouting {
  device: TapRegionDevice;
  preferences: ReaderTapPreferences;
  /** Undefined = left to right. */
  progression?: PageProgression;
  geometry: TapRegionGeometry;
  /** Left edge of the presentation host in top-level client coordinates; null when detached. */
  hostLeft(): number | null;
  /** Top edge of the same host; without it the top strip is not carved out. */
  hostTop?(): number | null;
  feedback: EdgeTurnFeedback;
}

export const ReaderTapRoutingContext = createContext<ReaderTapRouting | null>(null);

/** Set by a host that owns turning for nested pages (the image spread): its leaves turn the pair. */
export const ReaderTurnOwnerContext = createContext<((direction: EdgeTurnDirection) => void) | null>(null);

export type ReaderTapRoute =
  | { kind: "turn"; side: TapRegionSide; direction: EdgeTurnDirection }
  | { kind: "center" }
  /** Touch only: an invisible top bookmark corner (A15), by physical side. */
  | { kind: "bookmark"; side: TapRegionSide }
  | { kind: "outside" };

export function createReaderTapGeometry(availableWidth: number, settings: ReaderTapRegionSettings | undefined): TapRegionGeometry {
  const profile = settings ? tapRegionProfileFor(settings.preferences, settings.device) : DEFAULT_TAP_REGION_PROFILE;
  return computeTapRegionGeometry(availableWidth, profile);
}

/**
 * `clientX`/`clientY` are top-level; `hostLeft`/`hostTop` are the presentation
 * host's edges in the same coordinates. The top strip is centre (PC) or, at its
 * outer corners on touch, the bookmark corners.
 */
export function routeReaderTap(
  routing: Pick<ReaderTapRouting, "device" | "preferences" | "geometry" | "progression">,
  hostLeft: number,
  clientX: number,
  vertical?: { hostTop: number; clientY: number },
): ReaderTapRoute {
  const region = tapRegionAt(routing.geometry, clientX - hostLeft,
    vertical ? vertical.clientY - vertical.hostTop : undefined);
  if (region === null) return { kind: "outside" };
  if (region === "corner-left" || region === "corner-right") {
    return routing.device === "touch"
      ? { kind: "bookmark", side: region === "corner-left" ? "left" : "right" }
      : { kind: "center" };
  }
  if (region === "center") return { kind: "center" };
  return { kind: "turn", side: region, direction: tapRegionAction(region, routing.device, routing.preferences, routing.progression) };
}

/** Feedback key of a physical side: the arrow belongs to the band that was tapped. */
export function edgeFeedbackKeyOf(side: TapRegionSide): EdgeTurnDirection {
  return side === "left" ? -1 : 1;
}

/**
 * The transparent band never grows past the default size: a wider custom
 * region is served by body routing instead. A narrower or disabled side
 * shrinks it. Default mode keeps the stylesheet size (undefined).
 */
export function edgeTurnOverlayOf(geometry: TapRegionGeometry, side: TapRegionSide): EdgeTurnRegion | undefined {
  if (geometry.availableWidth <= 0 || geometry.mode === "default") return undefined;
  const band = side === "left" ? geometry.left : geometry.right;
  const fallback = computeTapRegionGeometry(geometry.availableWidth, DEFAULT_TAP_REGION_PROFILE)[side].width;
  return { width: Math.min(band.width, fallback), arrowCenter: band.arrowCenter };
}

export interface EdgeTurnZoneSpec {
  side: TapRegionSide;
  direction: EdgeTurnDirection;
  /** Only when it differs from the original layout; omitted keeps the old markup. */
  sideProp?: TapRegionSide;
  region?: EdgeTurnRegion;
}

/** EdgeTurnZone props for both physical sides; without routing this is the original prev/next pair. */
export function edgeTurnZoneSpecs(routing: ReaderTapRouting | null): EdgeTurnZoneSpec[] {
  return (["left", "right"] as const).map((side) => {
    if (!routing) return { side, direction: side === "left" ? -1 : 1 };
    const direction = tapRegionAction(side, routing.device, routing.preferences, routing.progression);
    const natural = (side === "left") === (direction === -1);
    return {
      side,
      direction,
      sideProp: natural ? undefined : side,
      region: edgeTurnOverlayOf(routing.geometry, side),
    };
  });
}

export function useReaderTapRouting(): ReaderTapRouting | null {
  return useContext(ReaderTapRoutingContext);
}
