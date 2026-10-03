import { addPluginListener, invoke, type PluginListener } from "@tauri-apps/api/core";

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
let activeSubscriptionId: number | null = null;
let nextSubscriptionId = 0;
let eventSubscription: Promise<PluginListener> | null = null;
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
    // Mobile Tauri retains registered channels. Keep one app-level listener;
    // start/stop only the system receiver, with a new ID for each session.
    eventSubscription ??= addPluginListener<unknown>("androidBattery", "battery-status", (payload) => {
      if (
        listeners.size === 0 || activeSubscriptionId === null ||
        typeof payload !== "object" || payload === null ||
        (payload as { subscriptionId?: unknown }).subscriptionId !== activeSubscriptionId
      ) return;
      notify(normalizeStatus(payload));
    }).catch((error) => {
      eventSubscription = null;
      throw error;
    });
    try {
      await eventSubscription;
      if (listeners.size === 0) return;
      const subscriptionId = ++nextSubscriptionId;
      activeSubscriptionId = subscriptionId;
      await invoke(ANDROID_BATTERY_SUBSCRIBE_COMMAND, { subscriptionId });
      if (listeners.size === 0) {
        activeSubscriptionId = null;
        lastStatus = null;
        await invoke(ANDROID_BATTERY_UNSUBSCRIBE_COMMAND).catch(() => {});
        return;
      }
      nativeSubscribed = true;
    } catch (error) {
      activeSubscriptionId = null;
      lastStatus = null;
      await invoke(ANDROID_BATTERY_UNSUBSCRIBE_COMMAND).catch(() => {});
      throw error;
    }
    return;
  }

  if (listeners.size === 0 && nativeSubscribed) {
    nativeSubscribed = false;
    activeSubscriptionId = null;
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
 * Subscribes to native Android battery updates through one app-level event.
 *
 * The returned function releases this listener. Native monitoring is stopped
 * only after the last listener releases, so any number of toolbar indicators
 * can share one subscription. The first value and every later update arrive
 * through the same callback stream. The lightweight event listener stays for
 * the app lifetime; no receiver or component listener remains after release.
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
