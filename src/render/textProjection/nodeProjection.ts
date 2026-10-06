import {
  codePointBoundary,
  projectPipeline,
  utf16Boundaries,
  type Bias,
} from "./core";
import type { CompiledTextProjection } from "./compile";

/**
 * Immutable per-Text-node snapshot. It keeps the original string, the display
 * string and explicit UTF-16↔code-point maps. Both directions are fragment
 * aware: non-identity replacement interiors always collapse to the fragment
 * edge selected by `bias`.
 */
export interface NodeProjection {
  readonly original: string;
  readonly display: string;
  readonly sourceUtf16Boundaries: readonly number[];
  readonly displayUtf16Boundaries: readonly number[];
  toDisplay(sourceUtf16Offset: number, bias?: Bias): number;
  toSource(displayUtf16Offset: number, bias?: Bias): number;
}

export function createNodeProjection(
  source: string,
  compiled: CompiledTextProjection,
): NodeProjection {
  const pipeline = projectPipeline(source, compiled.stages);
  const sourceUtf16Boundaries = utf16Boundaries(source);
  const displayUtf16Boundaries = utf16Boundaries(pipeline.display);
  return {
    original: source,
    display: pipeline.display,
    sourceUtf16Boundaries,
    displayUtf16Boundaries,
    toDisplay(sourceUtf16Offset: number, bias: Bias = "start"): number {
      const sourceCodePoint = codePointBoundary(sourceUtf16Boundaries, sourceUtf16Offset);
      const displayCodePoint = pipeline.toDisplay(sourceCodePoint, bias);
      const index = Math.max(0, Math.min(displayCodePoint, displayUtf16Boundaries.length - 1));
      return displayUtf16Boundaries[index] ?? 0;
    },
    toSource(displayUtf16Offset: number, bias: Bias = "start"): number {
      const displayCodePoint = codePointBoundary(displayUtf16Boundaries, displayUtf16Offset);
      const sourceCodePoint = pipeline.toSource(displayCodePoint, bias);
      const index = Math.max(0, Math.min(sourceCodePoint, sourceUtf16Boundaries.length - 1));
      return sourceUtf16Boundaries[index] ?? 0;
    },
  };
}

/**
 * Map a display raw UTF-16 range back to the original raw UTF-16 range.
 * Start and end use opposite biases so the whole non-invertible fragment is
 * represented instead of silently pretending it can be reversed.
 */
export function sourceRangeForDisplayRange(
  source: string,
  compiled: CompiledTextProjection,
  start: number,
  end: number,
): { start: number; end: number } | null {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const projection = createNodeProjection(source, compiled);
  const sourceStart = projection.toSource(start, "start");
  const sourceEnd = projection.toSource(end, "end");
  return sourceEnd > sourceStart ? { start: sourceStart, end: sourceEnd } : null;
}
