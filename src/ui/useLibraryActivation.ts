import { useEffect, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { startCloudSync } from "./cloudSync/cloudSyncStore";
import { uiText } from "./localization/UiLanguageProvider";
import type { ProgressRuntimeGate } from "./portableState/progressRuntimeGate";
import { activatePortableShelfState, LibraryDatabaseBlockedError } from "./shelf";
import type { ShelfNotice, useShelfLibrary } from "./useShelfLibrary";

export function useLibraryActivation({
  libraryReader,
  organizationReader,
  progressRuntimeGateRef,
  refreshShelfProjection,
  setShelfNotice,
}: {
  libraryReader: ReturnType<typeof useShelfLibrary>["libraryReader"];
  organizationReader: ReturnType<typeof useShelfLibrary>["organizationReader"];
  progressRuntimeGateRef: MutableRefObject<ProgressRuntimeGate | null>;
  refreshShelfProjection: ReturnType<typeof useShelfLibrary>["refreshShelfProjection"];
  setShelfNotice: Dispatch<SetStateAction<ShelfNotice>>;
}): void {
  // ---- 书架与组织启动加载（先完成一次 CP-I 激活，失败保持旧模式） ----
  const [cloudSyncReady, setCloudSyncReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let activated = false;
      try {
        await activatePortableShelfState();
        activated = true;
      } catch (error) {
        if (!cancelled) {
          setShelfNotice({
            kind: "error",
            text: error instanceof LibraryDatabaseBlockedError
              ? error.message
              : uiText("notice.portable.inactive", { error: String(error) }),
          });
        }
      }
      // Activation may change the repository instance behind the facade, so
      // the first real open must not reuse a pre-activation cached check.
      progressRuntimeGateRef.current?.invalidate();
      if (cancelled) return;
      void libraryReader.load().finally(() => {
        if (!cancelled && activated) setCloudSyncReady(true);
      });
      void organizationReader.load();
    })();

    return () => {
      cancelled = true;
      libraryReader.invalidate();
      organizationReader.invalidate();
    };
  }, [libraryReader, organizationReader]);

  // ---- 云同步（A25）：书库激活、书架首次读取之后才开始；同步改动了资料只刷新书架和文件夹 ----
  useEffect(() => {
    if (!cloudSyncReady) return;
    return startCloudSync({
      // A failed refresh stays on the shelf as a refresh error with a retry.
      onLibraryChanged: () => { void refreshShelfProjection().catch(() => undefined); },
    });
  }, [cloudSyncReady, refreshShelfProjection]);
}
