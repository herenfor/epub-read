import { addPluginListener, invoke, type PluginListener } from "@tauri-apps/api/core";

/** Reader-scoped volume-key paging preference. `reverse` only swaps the two keys. */
export type VolumeKeyMode = "off" | "on" | "reverse";

const TURN_PREFERENCE_KEY = "epub-reader:volume-key-turn";
const REVERSE_PREFERENCE_KEY = "epub-reader:volume-key-turn-reverse";
const SET_MODE_COMMAND = "android_volume_key_set_mode";

/** Off unless the device-local value is exactly "true"; unreadable storage stays off. */
export function readVolumeKeyTurn(): boolean {
  try { return localStorage.getItem(TURN_PREFERENCE_KEY) === "true"; }
  catch { return false; }
}

export function writeVolumeKeyTurn(enabled: boolean): void {
  localStorage.setItem(TURN_PREFERENCE_KEY, String(enabled));
}

export function readVolumeKeyReverse(): boolean {
  try { return localStorage.getItem(REVERSE_PREFERENCE_KEY) === "true"; }
  catch { return false; }
}

export function writeVolumeKeyReverse(reverse: boolean): void {
  localStorage.setItem(REVERSE_PREFERENCE_KEY, String(reverse));
}

export interface VolumeKeyIntent {
  readonly readerActive: boolean;
  readonly enabled: boolean;
  readonly reverse: boolean;
  readonly visible: boolean;
}

/** Native is armed only while the reader is actually on screen and visible. */
export function volumeKeyModeFor(intent: VolumeKeyIntent): VolumeKeyMode {
  if (!intent.readerActive || !intent.enabled || !intent.visible) return "off";
  return intent.reverse ? "reverse" : "on";
}

export async function setNativeVolumeKeyMode(mode: VolumeKeyMode): Promise<void> {
  await invoke<void>(SET_MODE_COMMAND, { mode });
}

/**
 * One app-root owner. Serial native writes coalesce to the latest route intent,
 * so a slow "on" cannot land after the reader already asked for "off".
 */
export function createVolumeKeyModeCoordinator(apply: (mode: VolumeKeyMode) => Promise<void> = setNativeVolumeKeyMode) {
  let desired: VolumeKeyMode | undefined;
  let revision = 0;
  let acknowledgedRevision = 0;
  let pending: Promise<void> | undefined;

  async function drain(): Promise<void> {
    try {
      while (acknowledgedRevision !== revision) {
        const applyingRevision = revision;
        const mode = desired!;
        try {
          await apply(mode);
        } catch (error) {
          if (applyingRevision !== revision) continue;
          throw error;
        }
        acknowledgedRevision = applyingRevision;
      }
    } finally {
      pending = undefined;
    }
  }

  return {
    /** force is for a new native window/rebinding, not every React render. */
    requestMode(mode: VolumeKeyMode, force = false): Promise<void> {
      if (desired !== mode || force) {
        desired = mode;
        revision += 1;
      }
      if (pending) return pending;
      if (acknowledgedRevision === revision) return Promise.resolve();
      pending = Promise.resolve().then(drain);
      return pending;
    },
  };
}

export type VolumeKeyTurnListener = (direction: 1 | -1) => void;

const listeners = new Set<VolumeKeyTurnListener>();
let eventSubscription: Promise<PluginListener> | null = null;

function normalizeDirection(payload: unknown): 1 | -1 | null {
  if (typeof payload !== "object" || payload === null) return null;
  const direction = (payload as { direction?: unknown }).direction;
  return direction === 1 || direction === -1 ? direction : null;
}

function ensureEventSubscription(): void {
  eventSubscription ??= addPluginListener<unknown>("androidVolumeKey", "volume-key", (payload) => {
    const direction = normalizeDirection(payload);
    if (direction === null) return;
    // A released listener must not receive a frame that was already queued.
    for (const listener of Array.from(listeners)) listener(direction);
  }).catch((error) => {
    eventSubscription = null;
    throw error;
  });
  void eventSubscription.catch((error) => {
    console.warn("Volume-key subscription failed", error);
  });
}

/**
 * Subscribes to native page-turn presses. The returned function only releases
 * this listener; the host turns the native mode off when leaving the reader.
 */
export function subscribeVolumeKeyTurn(listener: VolumeKeyTurnListener): () => void {
  listeners.add(listener);
  ensureEventSubscription();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    listeners.delete(listener);
  };
}
