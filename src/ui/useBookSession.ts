import { useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Book } from "../core/types";
import type { ResourceServer } from "../render/resources";
import type { ChapterCountCollection } from "./chapterCounts";
import { createChapterCountCollection } from "./chapterCounts";
import type { ContentAxis } from "./readerProgressAxis";

export type ActiveBookSession = {
  generation: number;
  book: Book;
  server: ResourceServer;
  bookKey: string;
  countCacheKey: string | null;
  structuralCounts: ChapterCountCollection;
};

export interface BookSession {
  readonly book: Book | null;
  readonly setBook: Dispatch<SetStateAction<Book | null>>;
  readonly bookRef: MutableRefObject<Book | null>;
  readonly server: ResourceServer | null;
  readonly setServer: Dispatch<SetStateAction<ResourceServer | null>>;
  readonly serverRef: MutableRefObject<ResourceServer | null>;
  readonly bookKey: string;
  readonly setBookKey: Dispatch<SetStateAction<string>>;
  readonly activeSessionRef: MutableRefObject<ActiveBookSession | null>;
  readonly sessionGenerationRef: MutableRefObject<number>;
  readonly chapterCountsRef: MutableRefObject<ChapterCountCollection>;
  readonly chapterCountsState: ChapterCountCollection;
  readonly setChapterCountsState: Dispatch<SetStateAction<ChapterCountCollection>>;
  readonly chapterCountJobRef: MutableRefObject<{ cancel(): void } | null>;
  readonly baselineProgressPctRef: MutableRefObject<number>;
  readonly lastCountProgressSignatureRef: MutableRefObject<string | null>;
  readonly contentAxis: ContentAxis | null;
  readonly setContentAxis: Dispatch<SetStateAction<ContentAxis | null>>;
  readonly contentAxisRef: MutableRefObject<ContentAxis | null>;
}

/**
 * C6：一本书的宿主状态（book/server/bookKey、章节计数组、内容轴）。
 * 只创建 state/ref；开书、离开与清理仍由 App/useBookOpen 调度。
 */
export function useBookSession(): BookSession {
  const [book, setBook] = useState<Book | null>(null);
  const [server, setServer] = useState<ResourceServer | null>(null);
  const [bookKey, setBookKey] = useState("");
  const bookRef = useRef<Book | null>(book);
  bookRef.current = book;
  const serverRef = useRef<ResourceServer | null>(server);
  serverRef.current = server;
  /** 异步章节字数统计：ref 是权威，state 只是 UI/派生快照。 */
  const [chapterCountsState, setChapterCountsState] = useState<ChapterCountCollection>(() =>
    createChapterCountCollection(0, [])
  );
  const chapterCountsRef = useRef(chapterCountsState);
  const sessionGenerationRef = useRef(0);
  const activeSessionRef = useRef<ActiveBookSession | null>(null);
  const baselineProgressPctRef = useRef(0);
  const chapterCountJobRef = useRef<{ cancel(): void } | null>(null);
  const lastCountProgressSignatureRef = useRef<string | null>(null);
  /** 统一固定内容轴：全书结构统计完成后冻结，跨模式、跨字号保持映射稳定 */
  const [contentAxis, setContentAxis] = useState<ContentAxis | null>(null);
  const contentAxisRef = useRef<ContentAxis | null>(null);
  return {
    book, setBook, bookRef, server, setServer, serverRef, bookKey, setBookKey,
    activeSessionRef, sessionGenerationRef, chapterCountsRef, chapterCountsState, setChapterCountsState,
    chapterCountJobRef, baselineProgressPctRef, lastCountProgressSignatureRef,
    contentAxis, setContentAxis, contentAxisRef,
  };
}
