import { useCallback, useEffect, useRef, useState } from "react";
import { moveAndroidTaskToBack } from "../platform/androidAppTask";

/** 书架根层“再滑一次退出”的提示/确认窗口。 */
const EXIT_BACK_WINDOW_MS = 2000;

export function useShelfExitBack(view: "shelf" | "reader") {
  // 书架根层返回两次退出：首次只提示，提示期内再次返回才退到后台。
  // 书架始终自己消费返回，避免 WebView 历史（iframe 导航）吃掉一次返回却没有任何反馈。
  const [exitBackHint, setExitBackHint] = useState(false);
  const exitBackArmedUntilRef = useRef(0);
  const exitBackHintTimerRef = useRef<number | null>(null);
  const clearExitBackHint = useCallback((): void => {
    exitBackArmedUntilRef.current = 0;
    if (exitBackHintTimerRef.current !== null) {
      window.clearTimeout(exitBackHintTimerRef.current);
      exitBackHintTimerRef.current = null;
    }
    setExitBackHint(false);
  }, []);
  const handleShelfRootBack = useCallback((): void => {
    if (Date.now() < exitBackArmedUntilRef.current) {
      clearExitBackHint();
      void moveAndroidTaskToBack().catch(() => undefined);
      return;
    }
    exitBackArmedUntilRef.current = Date.now() + EXIT_BACK_WINDOW_MS;
    if (exitBackHintTimerRef.current !== null) window.clearTimeout(exitBackHintTimerRef.current);
    setExitBackHint(true);
    exitBackHintTimerRef.current = window.setTimeout(clearExitBackHint, EXIT_BACK_WINDOW_MS);
  }, [clearExitBackHint]);
  useEffect(() => {
    if (view !== "shelf") clearExitBackHint();
  }, [view, clearExitBackHint]);
  useEffect(() => () => {
    if (exitBackHintTimerRef.current !== null) window.clearTimeout(exitBackHintTimerRef.current);
  }, []);

  return { exitBackHint, handleShelfRootBack, clearExitBackHint };
}
