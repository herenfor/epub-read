import type { CompiledTextProjection } from "./compile";
import { createNodeProjection, type NodeProjection } from "./nodeProjection";
import { utf16Boundaries } from "./core";

const PROJECTION_EXCLUDED_TAGS = new Set(["pre", "code", "kbd", "samp", "svg", "script", "style"]);

/** First-version boundary: code/SVG text remains byte-for-byte original. */
export function isProjectionExcludedTextNode(node: Text): boolean {
  let element = node.parentElement;
  while (element) {
    if (PROJECTION_EXCLUDED_TAGS.has(element.tagName.toLowerCase())) return true;
    element = element.parentElement;
  }
  return false;
}

export interface ApplyProjectionOptions {
  /** Return false when the document/config generation is stale. */
  isCurrent?: () => boolean;
  /** Yield control between batches so a long chapter does not monopolize the main thread. */
  yieldToHost?: () => Promise<void>;
  /** Nodes processed per yielded batch. */
  batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 2000;

/**
 * Per-document projection snapshot. The WeakMap keys are live Text nodes, so
 * dropping this session releases every text-node reference without retaining
 * the old document.
 */
export class TextProjectionSession {
  private compiled: CompiledTextProjection | null = null;
  private readonly nodes = new WeakMap<Text, NodeProjection>();
  private readonly pieces = new WeakMap<NodeProjection, {
    root: NodeProjection; sourceStart: number; displayStart: number;
  }>();

  get version(): string | null {
    return this.compiled?.version ?? null;
  }

  get nodeMap(): WeakMap<Text, NodeProjection> {
    return this.nodes;
  }

  projectionForNode(node: Text): NodeProjection | undefined {
    return this.nodes.get(node);
  }

  /** Keep a reader-owned DOM cut outside a replacement fragment. */
  splitBoundary(node: Text, displayOffset: number): number {
    const p = this.nodes.get(node);
    return p ? p.toDisplay(p.toSource(displayOffset, "end"), "end") : displayOffset;
  }

  /** Page seams split display nodes; keep canonical source mappings on both
   * pieces, and return an exact undo for the seam's owner. */
  trackSplit(left: Text, right: Text, displayOffset: number): () => void {
    const p = this.nodes.get(left);
    if (!p) return () => {};
    const sourceOffset = p.toSource(displayOffset, "end");
    const parent = this.pieces.get(p) ?? { root: p, sourceStart: 0, displayStart: 0 };
    const slice = (s0: number, s1: number, d0: number, d1: number): NodeProjection => {
      const sourceStart = parent.sourceStart + s0, displayStart = parent.displayStart + d0;
      const root = parent.root;
      const piece: NodeProjection = {
        original: p.original.slice(s0, s1), display: p.display.slice(d0, d1),
        // Mapping uses the shared root snapshot. Avoid rebuilding large prefix
        // arrays for every cut in a single long projected paragraph.
        get sourceUtf16Boundaries() { return utf16Boundaries(this.original); },
        get displayUtf16Boundaries() { return utf16Boundaries(this.display); },
        toDisplay: (offset, bias) => Math.max(0, Math.min(d1 - d0, root.toDisplay(sourceStart + offset, bias) - displayStart)),
        toSource: (offset, bias) => Math.max(0, Math.min(s1 - s0, root.toSource(displayStart + offset, bias) - sourceStart)),
      };
      this.pieces.set(piece, { root, sourceStart, displayStart });
      return piece;
    };
    this.nodes.set(left, slice(0, sourceOffset, 0, displayOffset));
    this.nodes.set(right, slice(sourceOffset, p.original.length, displayOffset, p.display.length));
    return () => { this.nodes.set(left, p); this.nodes.delete(right); };
  }

  /** Apply or replace the current compiled projection on the supplied nodes. */
  async apply(
    nodes: readonly Text[],
    compiled: CompiledTextProjection | null,
    options: ApplyProjectionOptions = {},
  ): Promise<void> {
    const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE));
    this.compiled = compiled;
    for (let index = 0; index < nodes.length; index++) {
      if (options.isCurrent && !options.isCurrent()) return;
      const node = nodes[index];
      if (!node) continue;
      const previous = this.nodes.get(node);
      const original = previous?.original ?? node.data;
      const projection = compiled
        ? createNodeProjection(original, compiled)
        : createNodeProjection(original, EMPTY_PROJECTION);
      this.nodes.set(node, projection);
      if (node.data !== projection.display) node.data = projection.display;
      if ((index + 1) % batchSize === 0 && index + 1 < nodes.length) {
        const yieldToHost = options.yieldToHost ?? defaultYield;
        await yieldToHost();
      }
    }
  }

  restore(nodes: readonly Text[]): void {
    for (const node of nodes) {
      const previous = this.nodes.get(node);
      if (previous && node.data !== previous.original) node.data = previous.original;
    }
  }
}

const EMPTY_PROJECTION: CompiledTextProjection = {
  version: "identity",
  stages: [],
  preferences: { mode: "original", rules: [] },
};

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
