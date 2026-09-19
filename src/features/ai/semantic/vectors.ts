/** Scaled L2 avoids overflow/underflow for finite input magnitudes. */
export function normalizeVector(vector: readonly number[], dimensions: number): number[] {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4096
    || vector.length !== dimensions || vector.some(v => !Number.isFinite(v))) throw new Error("向量维度或数值无效");
  let scale = 0;
  for (const value of vector) scale = Math.max(scale, Math.abs(value));
  if (scale === 0) throw new Error("拒绝零向量");
  const scaled = vector.map(v => v / scale);
  const norm = Math.sqrt(scaled.reduce((sum, v) => sum + v * v, 0));
  return scaled.map(v => v / norm);
}
/** Flat [tokens, dimensions] output for a single input; padding mask is mandatory. */
export function poolTokens(values: readonly number[], mask: readonly number[], dimensions: number, pooling: "cls" | "mean"): number[] {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4096
    || mask.length < 1 || mask.length > 8192 || values.length !== mask.length * dimensions
    || values.some(v => !Number.isFinite(v)) || mask.some(v => v !== 0 && v !== 1)
    || !["cls", "mean"].includes(pooling)) throw new Error("模型输出或 attention mask 无效");
  if (pooling === "cls") {
    if (mask[0] !== 1) throw new Error("CLS 位置被 padding 遮蔽");
    return normalizeVector(values.slice(0, dimensions), dimensions);
  }
  const count = mask.reduce((sum, value) => sum + value, 0);
  if (!count) throw new Error("没有有效 token");
  const output = Array<number>(dimensions).fill(0);
  for (let t = 0; t < mask.length; t++) {
    if (mask[t]) for (let d = 0; d < dimensions; d++) output[d] += values[t * dimensions + d] / count;
  }
  return normalizeVector(output, dimensions);
}
export interface Scored<T> { score: number; ordinal: number; value: T }
/** Small exact Top-K, bounded retained memory; ties follow source order. */
export class ExactTopK<T> {
  private readonly hits: Scored<T>[] = [];
  constructor(private readonly k: number) {
    if (!Number.isInteger(k) || k < 1 || k > 100) throw new Error("Top-K 必须在 1 到 100 之间");
  }
  add(hit: Scored<T>): void {
    if (!Number.isFinite(hit.score) || !Number.isSafeInteger(hit.ordinal) || hit.ordinal < 0) throw new Error("检索得分或序号无效");
    const index = this.hits.findIndex(h => hit.score > h.score || (hit.score === h.score && hit.ordinal < h.ordinal));
    this.hits.splice(index < 0 ? this.hits.length : index, 0, hit);
    if (this.hits.length > this.k) this.hits.pop();
  }
  results(): readonly Scored<T>[] { return this.hits.map(hit => ({ ...hit })); }
}
