import { Channel, invoke } from "@tauri-apps/api/core";

export interface BatteryStatus {
  levelPct: number | null;
  charging: boolean | null;
}

export type BatteryStatusListener = (status: BatteryStatus) => void;

const ANDROID_BATTERY_SUBSCRIBE_COMMAND = "android_battery_subscribe";
const ANDROID_BATTERY_UNSUBSCRIBE_COMMAND = "android_battery_unsubscribe";

const listeners = new Set<BatteryStatusListener>();
let lastStatus: BatteryStatus | null = null;
let nativeSubscribed = false;
let activeChannel: Channel<unknown> | null = null;
let lifecycle: Promise<void> = Promise.resolve();

function normalizeStatus(payload: unknown): BatteryStatus {
  const record =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};

  const rawLevel = record.levelPct;
  const levelPct =
    typeof rawLevel === "number" && Number.isFinite(rawLevel)
      ? rawLevel < 0 || rawLevel > 100
        ? null
        : Math.round(rawLevel)
      : null;

  const rawCharging = record.charging;
  const charging = typeof rawCharging === "boolean" ? rawCharging : null;

  return { levelPct, charging };
}

function notify(status: BatteryStatus): void {
  lastStatus = status;
  for (const listener of Array.from(listeners)) {
    listener(status);
  }
}

async function synchronize(): Promise<void> {
  if (listeners.size > 0 && !nativeSubscribed) {
    const channel = new Channel<unknown>((payload) => {
      if (activeChannel !== channel || listeners.size === 0) return;
      notify(normalizeStatus(payload));
    });
    activeChannel = channel;
    try {
      await invoke(ANDROID_BATTERY_SUBSCRIBE_COMMAND, { onStatus: channel });
      if (listeners.size === 0) {
        activeChannel = null;
        lastStatus = null;
        await invoke(ANDROID_BATTERY_UNSUBSCRIBE_COMMAND).catch(() => {});
        return;
      }
      nativeSubscribed = true;
    } catch (error) {
      activeChannel = null;
      lastStatus = null;
      await invoke(ANDROID_BATTERY_UNSUBSCRIBE_COMMAND).catch(() => {});
      throw error;
    }
    return;
  }

  if (listeners.size === 0 && nativeSubscribed) {
    nativeSubscribed = false;
    activeChannel = null;
    lastStatus = null;
    await invoke(ANDROID_BATTERY_UNSUBSCRIBE_COMMAND);
  }
}

function enqueueSync(): void {
  lifecycle = lifecycle
    .then(synchronize)
    .catch((error) => {
      console.warn("Battery status subscription failed", error);
    });
}

/**
 * Subscribes to native Android battery updates through one shared channel.
 *
 * The returned function releases this listener. Native monitoring is stopped
 * only after the last listener releases, so any number of toolbar indicators
 * can share one subscription. The first value and every later update arrive
 * through the same callback stream.
 */
export function subscribeBattery(listener: BatteryStatusListener): () => void {
  listeners.add(listener);
  if (lastStatus) {
    listener(lastStatus);
  }
  enqueueSync();

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    listeners.delete(listener);
    enqueueSync();
  };
}
