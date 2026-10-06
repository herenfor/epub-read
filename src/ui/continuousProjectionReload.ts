import type { CompiledTextProjection } from "../render/textProjection/compile";
import type { TextProjectionPreferences } from "../render/textProjection/types";

export interface ProjectionReloadSnapshot {
  readonly version: string;
  readonly preferences: TextProjectionPreferences;
  readonly compiled: CompiledTextProjection | null;
}

export interface ProjectionReloadTarget {
  /** False once the slot is unmounted or replaced in the live slot map. */
  isAlive(): boolean;
  setProjectionPreferences(snapshot: ProjectionReloadSnapshot): void;
  reloadProjection(snapshot: ProjectionReloadSnapshot): Promise<void>;
  waitProjectionReady(): Promise<boolean>;
  markProjectionError(): void;
}

export interface ProjectionReloadHooks<K> {
  onOwnerStart(key: K, generation: number): void;
  onOwnerRelease(key: K, generation: number): void;
  onFinished(generation: number): void;
}

/**
 * Serializes one T-1 configuration reload pass over the currently mounted
 * continuous slots. A newer pass invalidates every await boundary of the old
 * pass, so an old chapter load can never overwrite a newer snapshot.
 */
export class ProjectionReloadCoordinator<K> {
  private generation = 0;
  private latestSnapshot: ProjectionReloadSnapshot | null = null;

  /** Update the snapshot used by newly created slots. Returns true on version change. */
  updateLatest(snapshot: ProjectionReloadSnapshot): boolean {
    const changed = this.latestSnapshot?.version !== snapshot.version;
    this.latestSnapshot = snapshot;
    return changed;
  }

  current(): ProjectionReloadSnapshot | null {
    return this.latestSnapshot;
  }

  /** Invalidate in-flight work without starting a new pass (unmount). */
  invalidate(): void {
    this.generation += 1;
  }

  async run(
    entries: ReadonlyArray<readonly [K, ProjectionReloadTarget]>,
    snapshot: ProjectionReloadSnapshot,
    hooks: ProjectionReloadHooks<K>,
  ): Promise<void> {
    const generation = ++this.generation;
    const alive = (): boolean => generation === this.generation;

    for (const [, target] of entries) {
      if (!alive() || !target.isAlive()) continue;
      target.setProjectionPreferences(snapshot);
    }

    for (const [key, target] of entries) {
      if (!alive()) return;
      if (!target.isAlive()) continue;
      hooks.onOwnerStart(key, generation);
      try {
        await target.reloadProjection(snapshot);
        if (!alive() || !target.isAlive()) return;
        const ready = await target.waitProjectionReady();
        if (!alive() || !target.isAlive()) return;
        if (!ready) target.markProjectionError();
      } catch {
        if (alive() && target.isAlive()) target.markProjectionError();
      } finally {
        hooks.onOwnerRelease(key, generation);
      }
    }

    if (!alive()) return;
    hooks.onFinished(generation);
  }
}
