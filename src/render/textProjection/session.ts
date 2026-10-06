import type { CompiledTextProjection } from "./compile";
import { createNodeProjection, type NodeProjection } from "./nodeProjection";

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

  get version(): string | null {
    return this.compiled?.version ?? null;
  }

  get nodeMap(): WeakMap<Text, NodeProjection> {
    return this.nodes;
  }

  projectionForNode(node: Text): NodeProjection | undefined {
    return this.nodes.get(node);
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
