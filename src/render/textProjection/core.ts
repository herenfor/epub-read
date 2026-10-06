/** T-1 projection core. All offsets in this file are Unicode code points. */

export type Bias = "start" | "end";

/** A single validated replacement. The caller owns ordering. */
export interface Replacement {
  from: string;
  to: string;
}

export interface Run {
  /** Code-point offsets in the stage input string. */
  sourceStart: number;
  sourceEnd: number;
  /** Code-point offsets in the stage output string. */
  displayStart: number;
  displayEnd: number;
  identity: boolean;
}

export interface Projection {
  source: string;
  display: string;
  runs: Run[];
}

type Trie = { next: Map<string, Trie>; rule?: Replacement };

function isUsableReplacement(rule: Replacement): boolean {
  return (
    typeof rule.from === "string" &&
    typeof rule.to === "string" &&
    rule.from.length > 0 &&
    rule.to.length > 0 &&
    rule.from.trim().length > 0 &&
    rule.to.trim().length > 0
  );
}

/** Validate nonempty rules once at the configuration boundary. First duplicate wins. */
export function compileReplacementStage(rules: readonly Replacement[]) {
  const root: Trie = { next: new Map() };
  for (const rule of rules) {
    if (!isUsableReplacement(rule)) continue;
    let branch = root;
    for (const char of rule.from) {
      let child = branch.next.get(char);
      if (!child) branch.next.set(char, (child = { next: new Map() }));
      branch = child;
    }
    branch.rule ??= rule;
  }
  return (source: string): Projection => {
    const chars = Array.from(source);
    const out: string[] = [];
    const runs: Run[] = [];
    let pos = 0;
    let displayPos = 0;
    while (pos < chars.length) {
      let branch = root;
      let chosen: Replacement | undefined;
      let end = pos + 1;
      for (let j = pos; j < chars.length; j++) {
        const child = branch.next.get(chars[j]);
        if (!child) break;
        branch = child;
        if (branch.rule) {
          chosen = branch.rule;
          end = j + 1;
        }
      }
      const input = chars.slice(pos, end).join("");
      const output = chosen?.to ?? input;
      const count = Array.from(output).length;
      const identity = input === output;
      const previous = runs.at(-1);
      if (identity && previous?.identity) {
        previous.sourceEnd = end;
        previous.displayEnd = displayPos + count;
      } else {
        runs.push({
          sourceStart: pos,
          sourceEnd: end,
          displayStart: displayPos,
          displayEnd: displayPos + count,
          identity,
        });
      }
      out.push(output);
      pos = end;
      displayPos += count;
    }
    return { source, display: out.join(""), runs };
  };
}

/** Exact edges; a non-invertible replacement interior expands toward bias. */
export function mapBoundary(
  projection: Projection,
  offset: number,
  direction: "toSource" | "toDisplay",
  bias: Bias,
): number {
  if (!projection.runs.length) return 0;
  const forward = direction === "toDisplay";
  const a0 = forward ? "sourceStart" : "displayStart";
  const a1 = forward ? "sourceEnd" : "displayEnd";
  const b0 = forward ? "displayStart" : "sourceStart";
  const b1 = forward ? "displayEnd" : "sourceEnd";
  const last = projection.runs[projection.runs.length - 1];
  const lastEnd = last[a1];
  if (offset <= 0) return projection.runs[0][b0];
  if (offset >= lastEnd) return last[b1];
  let low = 0;
  let high = projection.runs.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (projection.runs[mid][a1] <= offset) low = mid + 1;
    else high = mid;
  }
  const run = projection.runs[low];
  if (!run) return last[b1];
  if (offset === run[a0]) return run[b0];
  if (run.identity) return run[b0] + offset - run[a0];
  return bias === "start" ? run[b0] : run[b1];
}

/** Keep stage maps; do not diff outputs or flatten ambiguities by length ratios. */
export function projectPipeline(
  source: string,
  stages: readonly ((source: string) => Projection)[],
) {
  const projections: Projection[] = [];
  let display = source;
  for (const stage of stages) {
    const projection = stage(display);
    projections.push(projection);
    display = projection.display;
  }
  return {
    source,
    display,
    projections,
    toSource(offset: number, bias: Bias = "start") {
      for (let i = projections.length - 1; i >= 0; i--) {
        offset = mapBoundary(projections[i], offset, "toSource", bias);
      }
      return offset;
    },
    toDisplay(offset: number, bias: Bias = "start") {
      for (const projection of projections) {
        offset = mapBoundary(projection, offset, "toDisplay", bias);
      }
      return offset;
    },
  };
}

/** DOM offsets are UTF-16. Keep these adapters separate from profile whitespace maps. */
export function utf16Boundaries(text: string): number[] {
  const boundaries = [0];
  for (const cp of text) boundaries.push(boundaries[boundaries.length - 1] + cp.length);
  return boundaries;
}

export function codePointBoundary(boundaries: readonly number[], utf16: number): number {
  const clamped = Math.max(0, Math.min(Number.isFinite(utf16) ? utf16 : 0, boundaries[boundaries.length - 1] ?? 0));
  let low = 0;
  let high = boundaries.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (boundaries[mid] <= clamped) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}

export function codePointLength(value: string): number {
  return Array.from(value).length;
}
