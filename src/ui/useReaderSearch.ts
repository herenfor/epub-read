import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Book } from "../core/types";
import type { SearchResult, SearchSession } from "../core/search";
import type { ResourceServer } from "../render/resources";
import type { CompiledTextProjection } from "../render/textProjection/compile";
import { createTextSearchSession, type TextSearchView } from "../render/textProjection/displaySearch";
import type { SearchPanelResult, SearchStatus } from "./SearchPanel";

// State, refs and effects have separate call sites to preserve App's ordering.
export function useReaderSearchView() {
  const [searchView, setSearchView] = useState<TextSearchView>("display");
  return { searchView, setSearchView };
}

export function useReaderSearchState() {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchStatus, setSearchStatus] = useState<SearchStatus>("idle");
  const [searchProgress, setSearchProgress] = useState({ processed: 0, total: 0 });
  const [searchError, setSearchError] = useState<string | undefined>(undefined);
  const [searchNavigationBusy, setSearchNavigationBusy] = useState(false);

  return { searchQuery, setSearchQuery, searchResults, setSearchResults, searchStatus, setSearchStatus,
    searchProgress, setSearchProgress, searchError, setSearchError, searchNavigationBusy, setSearchNavigationBusy };
}

export function useReaderSearchRefs() {
  const searchSessionRef = useRef<SearchSession | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchGenerationRef = useRef(0);
  return { searchSessionRef, searchAbortRef, searchGenerationRef };
}

type ReaderSearchState = ReturnType<typeof useReaderSearchState>;
type ReaderSearchRefs = ReturnType<typeof useReaderSearchRefs>;
type ReaderSearchContext = ReaderSearchState & ReaderSearchRefs & {
  view: "shelf" | "reader";
  book: Book | null;
  server: ResourceServer | null;
  searchView: TextSearchView;
  compiledTextProjection: CompiledTextProjection | null;
};

export function useReaderSearchSession({ view, book, server, searchView, compiledTextProjection,
  searchAbortRef, searchSessionRef, searchGenerationRef,
  setSearchResults, setSearchStatus, setSearchProgress, setSearchError, setSearchNavigationBusy,
}: ReaderSearchContext) {
  // 搜索索引按“打开一本书”的会话持有；创建本身不读取章节，首次查询才
  // 按 spine 渐进提取。换书/返回书架时释放全部正文和位置映射。
  useEffect(() => {
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    searchSessionRef.current?.dispose();
    searchSessionRef.current = null;
    searchGenerationRef.current++;
    setSearchResults([]);
    setSearchStatus("idle");
    setSearchProgress({ processed: 0, total: 0 });
    setSearchError(undefined);
    setSearchNavigationBusy(false);
    if (view !== "reader" || !book || !server || book.fixedLayout) return;
    const session = createTextSearchSession(
      book,
      searchView,
      searchView === "display" ? compiledTextProjection : null,
      { resourceServer: server },
    );
    searchSessionRef.current = session;
    return () => {
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
      if (searchSessionRef.current === session) searchSessionRef.current = null;
      session.dispose();
      searchGenerationRef.current++;
    };
  }, [view, book, server, searchView, compiledTextProjection]);
}

export function useReaderSearchQuery({ searchOpen, searchQuery, book, searchView, compiledTextProjection,
  searchAbortRef, searchSessionRef, searchGenerationRef,
  setSearchResults, setSearchStatus, setSearchProgress, setSearchError,
}: ReaderSearchContext & { searchOpen: boolean }) {
  // 输入防抖只延迟查询，不延迟取消：每次改字都会立即终止旧扫描，已完成
  // 的章节仍保留在 SearchSession 内供新查询复用。
  useEffect(() => {
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    const generation = ++searchGenerationRef.current;
    const query = searchQuery.trim();
    const session = searchSessionRef.current;
    if (!searchOpen || !session) {
      setSearchResults([]);
      setSearchStatus("idle");
      setSearchProgress({ processed: 0, total: 0 });
      setSearchError(undefined);
      return;
    }
    if (!query) {
      setSearchResults([]);
      setSearchStatus("idle");
      setSearchProgress({ processed: 0, total: 0 });
      setSearchError(undefined);
      return;
    }
    setSearchStatus("searching");
    setSearchProgress({
      processed: 0,
      total: book?.spine.filter((item) => item.linear).length ?? 0,
    });
    setSearchError(undefined);
    const timer = window.setTimeout(() => {
      const controller = new AbortController();
      searchAbortRef.current = controller;
      const request = session.search(query, {
        signal: controller.signal,
        maxResults: 101,
        onProgress: ({ completed, total }) => {
          if (generation !== searchGenerationRef.current) return;
          setSearchProgress({ processed: completed, total });
        },
      });
      void request.then((results) => {
        if (generation !== searchGenerationRef.current) return;
        setSearchResults(results);
        setSearchStatus("complete");
      }).catch((error: unknown) => {
        if (generation !== searchGenerationRef.current || (error as Error)?.name === "AbortError") return;
        setSearchError(String(error));
        setSearchStatus("error");
      }).finally(() => {
        if (searchAbortRef.current === controller) searchAbortRef.current = null;
      });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
    };
  }, [searchOpen, searchQuery, book, searchView, compiledTextProjection]);
}

export function useReaderSearchPanel({ searchResults, setSearchResults, setSearchStatus, setSearchProgress, setSearchError,
  searchAbortRef, searchGenerationRef, setSearchView,
}: ReaderSearchState & ReaderSearchRefs & Pick<ReturnType<typeof useReaderSearchView>, "setSearchView">) {
  const searchPanelResults = useMemo<SearchPanelResult[]>(() =>
    searchResults.map((result) => ({
      id: `${result.spineIndex}:${result.originalRange.start}:${result.originalRange.end}:${result.display?.range.start ?? -1}:${result.display?.range.end ?? -1}:${result.matchType}`,
      chapterTitle: result.chapterTitle,
      chapterPath: result.chapterPath,
      snippet: result.snippet,
      matchRanges: result.snippetMatchRanges,
    })), [searchResults]);

  const handleSearchViewChange = useCallback((view: TextSearchView) => {
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    searchGenerationRef.current++;
    setSearchView(view);
    setSearchResults([]);
    setSearchStatus("idle");
    setSearchError(undefined);
  }, [searchAbortRef, searchGenerationRef, setSearchView, setSearchResults, setSearchStatus, setSearchError]);
  const handleSearchCancel = useCallback(() => {
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    searchGenerationRef.current++;
    setSearchResults([]);
    setSearchStatus("idle");
    setSearchProgress({ processed: 0, total: 0 });
  }, [searchAbortRef, searchGenerationRef, setSearchResults, setSearchStatus, setSearchProgress]);
  return { searchPanelResults, handleSearchViewChange, handleSearchCancel };
}
