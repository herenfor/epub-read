import { useCallback, useEffect, useMemo, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
  createReaderStatusBarCoordinator,
  shouldHideReaderSystemStatusBar,
} from "../platform/readerSystemStatusBar";
import {
  readHideReaderSystemStatusBar,
  writeHideReaderSystemStatusBar,
  setReaderSystemStatusBarHidden,
  createStatusBarAppearanceCoordinator,
} from "../platform/androidReaderSystemStatusBar";
import {
  createReaderKeepScreenOnCoordinator,
  readReaderKeepScreenOn,
  shouldKeepReaderScreenOn,
  writeReaderKeepScreenOn,
} from "../platform/androidReaderKeepScreenOn";
import {
  createVolumeKeyModeCoordinator,
  createVolumeKeyModeGate,
  ensureVolumeKeySubscription,
  readVolumeKeyReverse,
  readVolumeKeyTurn,
  writeVolumeKeyReverse,
  writeVolumeKeyTurn,
} from "../platform/androidVolumeKeys";
import type { RuntimeCapabilities } from "../platform/runtimeCapabilities";
import type { ReaderSettings } from "../render/settings";
import { readBatteryIndicatorEnabled, writeBatteryIndicatorEnabled } from "./batteryPreferences";
import { uiText } from "./localization/UiLanguageProvider";
import type { ReaderTapPreferences } from "./readerTapRegions";
import { readTapRegionPreferences, writeTapRegionPreferences } from "./tapRegionPreferences";
import type { ShelfNotice } from "./useShelfLibrary";

export interface ReaderPlatformPreferencesDeps {
  runtime: RuntimeCapabilities;
  view: "shelf" | "reader";
  viewRef: MutableRefObject<"shelf" | "reader">;
  mobileChrome: boolean;
  theme: ReaderSettings["theme"];
  setShelfNotice: Dispatch<SetStateAction<ShelfNotice>>;
  showReaderNotice: (text: string, kind?: "ok" | "warn" | "error") => void;
}

export function useReaderPlatformPreferences({
  runtime,
  view,
  viewRef,
  mobileChrome,
  theme,
  setShelfNotice,
  showReaderNotice,
}: ReaderPlatformPreferencesDeps) {
  const [batteryIndicatorEnabled, setBatteryIndicatorEnabled] = useState(readBatteryIndicatorEnabled);
  const changeBatteryIndicatorEnabled = useCallback((enabled: boolean) => {
    setBatteryIndicatorEnabled(enabled);
    writeBatteryIndicatorEnabled(enabled);
  }, []);
  // 点击翻页区域：本机偏好，PC 与触屏各一份；Android 平板按触屏界面判定，不因宽屏算作 PC。
  const [tapRegionPreferences, setTapRegionPreferences] = useState(readTapRegionPreferences);
  const changeTapRegionPreferences = useCallback((next: ReaderTapPreferences) => {
    setTapRegionPreferences(next);
    writeTapRegionPreferences(next);
  }, []);
  const tapRegions = useMemo(() => ({
    device: mobileChrome ? "touch" as const : "pc" as const,
    preferences: tapRegionPreferences,
  }), [mobileChrome, tapRegionPreferences]);
  const [hideReaderSystemStatusBar, setHideReaderSystemStatusBar] = useState(readHideReaderSystemStatusBar);
  const [readerSystemBars] = useState(() => createReaderStatusBarCoordinator(setReaderSystemStatusBarHidden));
  const [statusBarAppearance] = useState(() => createStatusBarAppearanceCoordinator());
  const changeHideReaderSystemStatusBar = useCallback((hidden: boolean) => {
    try {
      writeHideReaderSystemStatusBar(hidden);
      setHideReaderSystemStatusBar(hidden);
    } catch (error) {
      setShelfNotice({ kind: "error", text: uiText("notice.statusBar.saveFailed", { error: String(error) }) });
    }
  }, []);
  const [keepScreenOnWhileReading, setKeepScreenOnWhileReading] = useState(readReaderKeepScreenOn);
  const [readerScreenOn] = useState(() => createReaderKeepScreenOnCoordinator());
  const changeKeepScreenOnWhileReading = useCallback((enabled: boolean) => {
    try {
      writeReaderKeepScreenOn(enabled);
      setKeepScreenOnWhileReading(enabled);
    } catch (error) {
      setShelfNotice({ kind: "error", text: uiText("notice.keepScreenOn.saveFailed", { error: String(error) }) });
    }
  }, []);
  const [volumeKeyTurn, setVolumeKeyTurn] = useState(readVolumeKeyTurn);
  const [volumeKeyReverse, setVolumeKeyReverse] = useState(readVolumeKeyReverse);
  const [volumeKeyModes] = useState(() => createVolumeKeyModeCoordinator());
  const changeVolumeKeyTurn = useCallback((enabled: boolean) => {
    try {
      writeVolumeKeyTurn(enabled);
      setVolumeKeyTurn(enabled);
    } catch (error) {
      setShelfNotice({ kind: "error", text: uiText("notice.volumeKeys.saveFailed", { error: String(error) }) });
    }
  }, []);
  const changeVolumeKeyReverse = useCallback((reverse: boolean) => {
    try {
      writeVolumeKeyReverse(reverse);
      setVolumeKeyReverse(reverse);
    } catch (error) {
      setShelfNotice({ kind: "error", text: uiText("notice.volumeKeys.saveFailed", { error: String(error) }) });
    }
  }, []);

  // Native may take the volume keys only after the event listener is really
  // registered. A failed subscription stays off and keeps the system volume.
  const [volumeKeyGate] = useState(() => createVolumeKeyModeGate({
    ensureSubscription: ensureVolumeKeySubscription,
    apply: (mode, force) => volumeKeyModes.requestMode(mode, force),
    onSubscriptionFailure: () => {
      const message = uiText("notice.volumeKeys.unavailable");
      if (viewRef.current === "reader") showReaderNotice(message, "warn");
      else setShelfNotice({ kind: "warn", text: message });
    },
  }));

  useEffect(() => {
    if (!runtime.supportsReaderSystemStatusBar) return;
    void readerSystemBars.requestHidden(shouldHideReaderSystemStatusBar({
      supported: true, readerActive: view === "reader", hideWhileReading: hideReaderSystemStatusBar,
    })).catch((error) => {
      const message = uiText("notice.statusBar.failed", { error: String(error) });
      if (view === "reader") showReaderNotice(message, "warn");
      else setShelfNotice({ kind: "warn", text: message });
    });
    // The app root owns the intent. Reader/menu cleanup must never submit a stale false.
  }, [view, hideReaderSystemStatusBar, runtime.supportsReaderSystemStatusBar, readerSystemBars, showReaderNotice]);

  useEffect(() => {
    if (!runtime.supportsReaderSystemStatusBar) return;
    void statusBarAppearance.requestTheme(theme).catch((error) => {
      const message = uiText("notice.statusBar.failed", { error: String(error) });
      if (view === "reader") showReaderNotice(message, "warn");
      else setShelfNotice({ kind: "warn", text: message });
    });
  }, [theme, view, runtime.supportsReaderSystemStatusBar, statusBarAppearance, showReaderNotice]);

  useEffect(() => {
    if (!runtime.supportsReaderKeepScreenOn) return;
    // Re-subscribed whenever route/preference change, so the listener never reads stale state.
    const submit = (force: boolean) => {
      void readerScreenOn.requestEnabled(shouldKeepReaderScreenOn({
        readerActive: view === "reader",
        keepWhileReading: keepScreenOnWhileReading,
        visible: document.visibilityState !== "hidden",
      }), force).catch((error) => {
        const message = uiText("notice.keepScreenOn.failed", { error: String(error) });
        if (view === "reader") showReaderNotice(message, "warn");
        else setShelfNotice({ kind: "warn", text: message });
      });
    };
    submit(false);
    // Native already clears the flag in the background; returning resubmits the current intent.
    const onVisibilityChange = () => submit(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [view, keepScreenOnWhileReading, runtime.supportsReaderKeepScreenOn, readerScreenOn, showReaderNotice]);
  useEffect(() => {
    if (!runtime.supportsReaderKeepScreenOn) return;
    // Root teardown goes through the same serializer; no second invoke chain.
    return () => { void readerScreenOn.requestEnabled(false).catch(() => {}); };
  }, [runtime.supportsReaderKeepScreenOn, readerScreenOn]);

  useEffect(() => {
    if (!runtime.supportsVolumeKeyTurn) return;
    // Leaving the app must never leave volume keys swallowing the system volume.
    return () => {
      volumeKeyGate.cancel();
      void volumeKeyModes.requestMode("off").catch(() => {});
    };
  }, [runtime.supportsVolumeKeyTurn, volumeKeyModes, volumeKeyGate]);

  return {
    batteryIndicatorEnabled,
    changeBatteryIndicatorEnabled,
    changeTapRegionPreferences,
    tapRegions,
    hideReaderSystemStatusBar,
    changeHideReaderSystemStatusBar,
    keepScreenOnWhileReading,
    changeKeepScreenOnWhileReading,
    volumeKeyTurn,
    volumeKeyReverse,
    changeVolumeKeyTurn,
    changeVolumeKeyReverse,
    volumeKeyGate,
  };
}
