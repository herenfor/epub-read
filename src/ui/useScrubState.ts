import { useCallback, useRef, useState } from "react";
import { initialScrubUi, reduceScrubUi, type ScrubToken, type ScrubUiEvent, type ScrubUiState } from "./readerProgressAxis";
import type { SidebarNavigationMemory } from "./sidebarSwipe";

export function useScrubState() {
  const scrubSessionRef = useRef(0);
  const scrubRequestIdRef = useRef(0);
  /**
   * 分页模式进度条跨章：先换章，目标章显示就绪后再按章内比例定位一次。
   * 一次性；就绪的不是目标章（期间又跳到别处）则丢弃。
   */
  const pendingChapterSeekRef = useRef<{
    target: { key: string; spineIndex: number; fraction: number };
    token: ScrubToken;
  } | null>(null);
  const [scrubUiState, setScrubUiState] = useState<ScrubUiState>(() => initialScrubUi(0));
  /** Latest progress-bar jump and the book's sidebar memory it was made in; only its real landing moves the TOC. */
  const tocFollowSeekRef = useRef<{ token: ScrubToken; fromHref?: string; memory: SidebarNavigationMemory } | null>(null);
  const tocFollowGenerationRef = useRef(0);
  // The pending target lives in the book's sidebar memory; this only re-renders the drawer.
  const [tocFollowRequest, setTocFollowRequest] = useState(0);
  const activeHrefRef = useRef<string | undefined>(undefined);
  const scrubUiStateRef = useRef(scrubUiState);

  const dispatchScrub = useCallback((event: ScrubUiEvent) => {
    // Navigation may report synchronously before React renders a begin/reset.
    const next = reduceScrubUi(scrubUiStateRef.current, event);
    scrubUiStateRef.current = next;
    setScrubUiState(next);
  }, []);

  const acceptsScrubResult = useCallback((token: ScrubToken): boolean => {
    const state = scrubUiStateRef.current;
    return state.session === token.session &&
      state.pending?.session === token.session && state.pending.request === token.request;
  }, []);
  return {
    scrubSessionRef,
    scrubRequestIdRef,
    pendingChapterSeekRef,
    scrubUiState,
    tocFollowSeekRef,
    tocFollowGenerationRef,
    tocFollowRequest,
    setTocFollowRequest,
    activeHrefRef,
    scrubUiStateRef,
    dispatchScrub,
    acceptsScrubResult,
  };
}
