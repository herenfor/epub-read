import type { CSSProperties } from "react";
import "./aaPopover.css";
import "./readerTapRegions.css";
import {
  computeTapRegionGeometry,
  DEFAULT_TAP_REGION_PROFILE,
  setTapRegionMode,
  setTapRegionPercent,
  TAP_REGION_MAX_PERCENT,
  TAP_REGION_TOP_INSET_PX,
  BOOKMARK_CORNER_PX,
  tapRegionAction,
  tapRegionProfileFor,
  tapRegionSplitOf,
  withTapRegionProfile,
  type ReaderTapPreferences,
  type TapRegionDevice,
  type TapRegionGeometry,
  type PageProgression,
  type TapRegionSide,
} from "./readerTapRegions";

/** Already translated by the host (see catalogs/tapRegions.ts); the host shows the title. */
export interface ReaderTapRegionsLabels {
  previewNote: string;
  size: string;
  modeDefault: string;
  modeCustom: string;
  rangeHint: string;
  left: string;
  right: string;
  center: string;
  centerAction: string;
  prev: string;
  next: string;
  off: string;
  narrowed: string;
  scrollMode: string;
  leftForward: string;
  leftForwardHint: string;
  rightForward: string;
  tapHint: string;
  tapHintHint: string;
  reset: string;
}

export interface ReaderTapRegionsPanelProps {
  /** Profile being edited: the current device class. */
  device: TapRegionDevice;
  value: ReaderTapPreferences;
  onChange(next: ReaderTapPreferences): void;
  /** Width/height of the box that hosts the real zones (same input as the reader's geometry). */
  availableWidth: number;
  availableHeight?: number;
  /** Text columns drawn in the preview page. */
  columns?: 1 | 2;
  /** Scroll mode has no tap turning; settings still apply to paged mode. */
  scrollMode?: boolean;
  /**
   * No book is open (shelf settings): the preview is a sample page at the
   * window's proportions, so it shows shares only, never pixel widths.
   */
  schematic?: boolean;
  labels: ReaderTapRegionsLabels;
  /** Direction of the open book: the preview and the back-side switch follow it. */
  progression?: PageProgression;
}

const PREVIEW_MAX_HEIGHT = 220;

function percentOf(geometry: TapRegionGeometry, px: number): string {
  return geometry.availableWidth > 0 ? `${(px / geometry.availableWidth) * 100}%` : "0%";
}

function amount(geometry: TapRegionGeometry, px: number, schematic?: boolean): string {
  const percent = geometry.availableWidth > 0 ? Math.round(px / geometry.availableWidth * 100) : 0;
  return schematic ? `${percent}%` : `${percent}% · ${Math.round(px)}px`;
}

/** Points at its own edge, like the reader's edge arrows; the band's action is in its label. */
function Chevron({ side }: { side: "left" | "right" }) {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points={side === "left" ? "15 18 9 12 15 6" : "9 18 15 12 9 6"} />
  </svg>;
}

/**
 * Settings and live preview for the tap-to-turn regions. Pure presentation:
 * it never turns pages, touches the book frame or storage; the host owns the
 * value and decides when to persist it.
 */
export function ReaderTapRegionsPanel(props: ReaderTapRegionsPanelProps) {
  const { device, value, labels } = props;
  const profile = tapRegionProfileFor(value, device);
  // Same function and width as the real zones: the preview is the hit map.
  const geometry = computeTapRegionGeometry(props.availableWidth, profile);
  const width = Math.max(1, geometry.availableWidth || 1);
  const height = Math.max(1, props.availableHeight && props.availableHeight > 0
    ? props.availableHeight : width * (device === "touch" ? 1.6 : 0.65));
  const custom = geometry.mode === "custom";
  const split = custom && profile.custom ? profile.custom : tapRegionSplitOf(geometry);
  const update = (next: typeof profile) => props.onChange(withTapRegionProfile(value, device, next));
  const actionLabel = (side: TapRegionSide) =>
    tapRegionAction(side, device, value, props.progression) === 1 ? labels.next : labels.prev;

  const previewStyle = {
    aspectRatio: `${width} / ${height}`,
    width: `min(100%, ${(PREVIEW_MAX_HEIGHT * width) / height}px)`,
  } as CSSProperties;
  // A15：两侧竖带让出顶部一条（书签丝带挂在那里）；手机右上角是书签点击区。
  const topInset = `${Math.min(40, (TAP_REGION_TOP_INSET_PX / height) * 100)}%`;
  const sideBand = (side: TapRegionSide) => {
    const band = side === "left" ? geometry.left : geometry.right;
    if (band.width <= 0) {
      return <span key={side} className={`tap-regions-off-tag is-${side}`}>{labels.off}</span>;
    }
    return [
      <div key={side} className={`tap-regions-band is-side is-${side}`}
        style={{ left: percentOf(geometry, band.start), width: percentOf(geometry, band.width), top: topInset }} />,
      <span key={`${side}-arrow`} className={`tap-regions-band-arrow is-${side}`}
        style={{ [side]: percentOf(geometry, band.arrowCenter) }}>
        <Chevron side={side} />
      </span>,
    ];
  };
  const legendSide = (side: TapRegionSide) => {
    const band = side === "left" ? geometry.left : geometry.right;
    return <div className="tap-regions-legend-item">
      <span className="tap-regions-legend-name">{side === "left" ? labels.left : labels.right} · {band.width > 0 ? actionLabel(side) : labels.off}</span>
      <span className="tap-regions-legend-value">{amount(geometry, band.width, props.schematic)}</span>
    </div>;
  };
  const slider = (side: TapRegionSide) => {
    const percent = split[side];
    const name = side === "left" ? labels.left : labels.right;
    return <label className="tap-regions-slider-row">
      <span className="aa-section-label">{name}</span>
      <input type="range" min={0} max={TAP_REGION_MAX_PERCENT} step={1} value={percent}
        aria-label={name} aria-valuetext={percent === 0 ? labels.off : `${percent}%`}
        onChange={(event) => update(setTapRegionPercent(profile, side, Number(event.target.value), geometry))} />
      <span className="tap-regions-slider-value">{percent === 0 ? labels.off : `${percent}%`}</span>
    </label>;
  };

  return <div className="tap-regions-panel" data-tap-device={device}>
    {props.scrollMode && <div className="tap-regions-note" role="note">{labels.scrollMode}</div>}

    <div className="tap-regions-preview" style={previewStyle} aria-hidden="true">
      <div className="tap-regions-page-lines">
        <div className="tap-regions-page-column" />
        {props.columns === 2 && <div className="tap-regions-page-column" />}
      </div>
      <div className="tap-regions-band is-center"
        style={{ left: percentOf(geometry, geometry.center.start), width: percentOf(geometry, geometry.center.width) }}>
        <span className="tap-regions-band-center-label">{labels.centerAction}</span>
      </div>
      {sideBand("left")}
      {sideBand("right")}
      {device === "touch" && <div className="tap-regions-bookmark-corner"
        style={{ width: percentOf(geometry, Math.min(BOOKMARK_CORNER_PX, geometry.availableWidth)), height: topInset }}>
        <span className="tap-regions-bookmark-glyph" />
      </div>}
    </div>
    <div className="tap-regions-legend">
      {legendSide("left")}
      <div className="tap-regions-legend-item">
        <span className="tap-regions-legend-name">{labels.center}</span>
        <span className="tap-regions-legend-value">{amount(geometry, geometry.center.width, props.schematic)}</span>
      </div>
      {legendSide("right")}
    </div>
    {!props.schematic && <span className="tap-regions-note">{labels.previewNote}</span>}
    {geometry.narrowed && <span className="tap-regions-note" role="note">{labels.narrowed}</span>}

    <div className="aa-control-row">
      <span className="aa-section-label">{labels.size}</span>
      <div className="aa-segmented-capsule" role="radiogroup" aria-label={labels.size}>
        {(["default", "custom"] as const).map((mode) => <button key={mode} type="button" role="radio"
          aria-checked={geometry.mode === mode}
          className={`aa-segmented-btn${geometry.mode === mode ? " active" : ""}`}
          onClick={() => { if (geometry.mode !== mode) update(setTapRegionMode(profile, mode, geometry)); }}>
          {mode === "default" ? labels.modeDefault : labels.modeCustom}
        </button>)}
      </div>
    </div>
    {custom && <>
      {slider("left")}
      {slider("right")}
      <span className="tap-regions-note">{labels.rangeHint}</span>
    </>}

    {device === "touch" && <div className="tap-regions-switch-row">
      <div className="tap-regions-switch-text">
        <span>{props.progression === "rtl" ? labels.rightForward : labels.leftForward}</span>
        <span className="tap-regions-note">{labels.leftForwardHint}</span>
      </div>
      <label className="aa-switch-label">
        <input type="checkbox" checked={value.touchLeftTapForward}
          aria-label={props.progression === "rtl" ? labels.rightForward : labels.leftForward}
          onChange={(event) => props.onChange({ ...value, touchLeftTapForward: event.target.checked })} />
        <span className="aa-switch-track" />
      </label>
    </div>}

    <div className="tap-regions-switch-row">
      <div className="tap-regions-switch-text">
        <span>{labels.tapHint}</span>
        <span className="tap-regions-note">{labels.tapHintHint}</span>
      </div>
      <label className="aa-switch-label">
        <input type="checkbox" checked={value.showTapHint} aria-label={labels.tapHint}
          onChange={(event) => props.onChange({ ...value, showTapHint: event.target.checked })} />
        <span className="aa-switch-track" />
      </label>
    </div>

    <button type="button" className="tap-regions-reset"
      disabled={profile.mode === "default" && profile.custom === undefined}
      onClick={() => update(DEFAULT_TAP_REGION_PROFILE)}>
      {labels.reset}
    </button>
  </div>;
}
