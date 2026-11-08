import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { disposeBook, spineIndexForEntryKey, spineItemPath } from "../core/book";
import { loadSourceArchive, loadSourceBook, sourceFormat, textEncodingFromPath } from "../core/documentFormats";
import { bookPickerExtensions } from "./bookFileTypes";
import type { ExactTextHit } from "../core/exactTextHits";
import { compareStamp, type Stamp, type Version } from "../core/portableState/portable-register-core";
import { latestVersion, projectProgressVersion, versionForStamp } from "../core/portableState/projection";
import type { Locator, ProgressValue } from "../core/portableState/portable-state-types";
import type { SearchOccurrence } from "../core/searchOccurrence";
import type { ArchiveClient } from "../core/selectiveArchive";
import { IS_AI_EDITION } from "../config/edition";
import type { Book } from "../core/types";
import type { ResolvedCrossBookSearchHit } from "../features/ai/indexing/indexStore";
import { getRuntimeCapabilities } from "../platform/runtimeCapabilities";
import type { ChapterState, MediaReadingAnchor } from "../render/paginator";
import { ResourceServer } from "../render/resources";
import { bookOpenErrorMessage, describeBookOpenFailure } from "./bookOpenFailure";
import { readCachedChapterCounts } from "./chapterCountCache";
import { applyChapterCount, createChapterCountCollection } from "./chapterCounts";
import { openingBaselinePct, persistCheckpointSample, planCheckpointOpen, stageCheckpointSample } from "./checkpointProgressRepair";
import { noteCloudSyncChange } from "./cloudSync/cloudSyncStore";
import type { ProgressSourceCandidate } from "./cloudSync/ProgressSourceChoices";
import { sha256Hex } from "./importBooks";
import type { LocalProgressCheckpoint } from "./localProgressCheckpoint";
import { uiText } from "./localization/UiLanguageProvider";
import { runPageTransition } from "./pageTransition";
import type { ProgressLease } from "./portableState/ownedProgressSessions";
import { progressValueFromPatch } from "./portableState/shelfStoreAdapter";
import { planFreshProgressOpen } from "./progressOpenOrder";
import { closeReaderForeground, type ReaderForeground } from "./readerForeground";
import { emptyReaderNavigationHistory, type ReaderNavigationHistory, type ReaderNavigationPosition } from "./readerNavigationHistory";
import { releaseUnsavedLane, type SaveFailurePrompt } from "./saveFailureExit";
import { getShelfStore, markShelfEntryOpened, type PortableProgressSelection, type ShelfEntry, type ShelfProgressPatch } from "./shelf";
import { shelfSpaceStorage } from "./shelfSpaces";
import type { SidebarNavigationMemory } from "./sidebarSwipe";
import type { SavedProgress } from "./storage";
import { readProgress } from "./storage";
import type { BookSession } from "./useBookSession";
import type { useBookImport } from "./useBookImport";
import type { useProgressRuntime } from "./useProgressRuntime";
import type { useReaderForeground } from "./useReaderForeground";
import type { ReaderSessionHost } from "./useReaderSession";
import type { useScrubState } from "./useScrubState";
import type { useShelfNoticeState } from "./useShelfLibrary";
import type { useShelfProgressCommit } from "./useShelfProgressCommit";

type AppPhase =
  | { phase: "idle" }
  | { phase: "loading"; fileName: string; title?: string; creator?: string }
  | { phase: "error"; message: string }
  | { phase: "ready" };

type ReaderHistoryPosition = ReaderNavigationPosition;

type PersistedReaderAnchor = {
  index: number;
  ratio: number;
  anchorTextOffset: number | null;
  anchorTextSnippet: string | null;
  /** B-155：纯图片页的可选媒体身份/比例；旧记录可读，缺省即低精度。 */
  mediaAnchor?: MediaReadingAnchor | null;
};

type ToPersistedReaderAnchor = (value: {
  index?: number | null;
  ratio?: number | null;
  anchorTextOffset?: number | null;
  anchorTextSnippet?: string | null;
  mediaAnchor?: MediaReadingAnchor | null;
} | null | undefined) => PersistedReaderAnchor | null;

type PreciseTarget = {
  requestId: number;
  kind: "search" | "note";
  chapterPath: string;
  textHits?: ExactTextHit[];
  occurrence?: SearchOccurrence;
  displayTarget?: import("../core/search").DisplaySearchTarget;
};

type PortableProgressChoiceCandidate = ProgressSourceCandidate & {
  readonly stamp: Stamp;
  readonly version: Version<ProgressValue>;
};

type ProgressRuntime = ReturnType<typeof useProgressRuntime>;
type ProgressCommit = ReturnType<typeof useShelfProgressCommit>;
type ScrubState = ReturnType<typeof useScrubState>;
type BookImport = ReturnType<typeof useBookImport>;
type ShelfNoticeSetter = ReturnType<typeof useShelfNoticeState>["setShelfNotice"];

export interface BookOpenActions {
  openParsedBook: (
    b: Book,
    srv: ResourceServer,
    fileName: string,
    fileSize: number,
    savedOverride: SavedProgress | null,
    shelfId: string | null,
    countCacheKey: string | null,
    baselineProgressPct: number,
    freshTextProfile?: boolean,
  ) => void;
  handleShelfOpen: (
    id: string,
    searchTarget?: ResolvedCrossBookSearchHit,
    searchTextHits?: ExactTextHit[],
    searchOccurrence?: SearchOccurrence,
    textEncodingOverride?: string,
  ) => Promise<void>;
  leaveReader: (leaveUnsaved: boolean, animate?: boolean, covered?: Promise<void>) => Promise<boolean>;
}

/**
 * C6：开书、离开与资源接管。
 * 只含 useCallback；book/server/计数组等状态由 useBookSession 所有。
 */
export function useBookOpen({
  setBook, bookRef, setServer, setBookKey,
  activeSessionRef, sessionGenerationRef, chapterCountsRef, setChapterCountsState,
  chapterCountJobRef, baselineProgressPctRef, lastCountProgressSignatureRef,
  setContentAxis, contentAxisRef,
  setChapterState, setAnchor, setInitialAnchor, setInitialPage, setSpineIndex,
  setCurrentShelfId, setReaderHistory, setView, setPhase, setRuntimeIssues, setSearchQuery,
  setSearchNavigationBusy, setPreciseTarget, setNoteBusy, setDiagText, setForeground,
  setShelfBusy, setShelfBusyMessage, setShelfEntries, setShelfError, setShelfNotice,
  setProgressChoice, setLocalCheckpointConflict, setSaveFailurePrompt,
  shelfBusyRef, shelfEntriesRef, persistShelfProgressRef, noteBusyRef,
  latestPreciseRequestRef, preciseRequestRef, progressChoiceResolverRef, localCheckpointResolverRef,
  scrubSessionRef, tocFollowSeekRef, sidebarNavigationMemoryRef, lastStablePositionRef,
  activeProgressLeaseRef, localCheckpointsRef, firstSampleFailureRecordedRef, progressWriterRef,
  closeForeground, closeImageOverlay, dispatchReaderSession, startRestore, dispatchScrub,
  ensureProgressRuntimeReady, retainUnsavedSample, recordLifecycleDiagnostic,
  persistShelfProgress, persistChapterCountCache, reimportAndroidMissing, showReaderNotice,
  runtime, isTauriEnv, toPersistedReaderAnchor, bookKeyOf, firstLinear, clamp,
  legacySavedProgress, savedProgressFromPortableLocator, savedProgressFromShelfEntry,
  savedProgressFromVersion, mergeProgressProjection, portableProgressVersions, sameCheckpointPatchValue,
}: {
  setBook: BookSession["setBook"];
  bookRef: BookSession["bookRef"];
  setServer: BookSession["setServer"];
  setBookKey: BookSession["setBookKey"];
  activeSessionRef: BookSession["activeSessionRef"];
  sessionGenerationRef: BookSession["sessionGenerationRef"];
  chapterCountsRef: BookSession["chapterCountsRef"];
  setChapterCountsState: BookSession["setChapterCountsState"];
  chapterCountJobRef: BookSession["chapterCountJobRef"];
  baselineProgressPctRef: BookSession["baselineProgressPctRef"];
  lastCountProgressSignatureRef: BookSession["lastCountProgressSignatureRef"];
  setContentAxis: BookSession["setContentAxis"];
  contentAxisRef: BookSession["contentAxisRef"];
  setChapterState: Dispatch<SetStateAction<ChapterState>>;
  setAnchor: Dispatch<SetStateAction<string | undefined>>;
  setInitialAnchor: Dispatch<SetStateAction<PersistedReaderAnchor | null>>;
  setInitialPage: Dispatch<SetStateAction<number | null>>;
  setSpineIndex: Dispatch<SetStateAction<number>>;
  setCurrentShelfId: Dispatch<SetStateAction<string | null>>;
  setReaderHistory: Dispatch<SetStateAction<ReaderNavigationHistory>>;
  setView: Dispatch<SetStateAction<"shelf" | "reader">>;
  setPhase: Dispatch<SetStateAction<AppPhase>>;
  setRuntimeIssues: Dispatch<SetStateAction<string[]>>;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  setSearchNavigationBusy: Dispatch<SetStateAction<boolean>>;
  setPreciseTarget: Dispatch<SetStateAction<PreciseTarget | null>>;
  setNoteBusy: Dispatch<SetStateAction<boolean>>;
  setDiagText: Dispatch<SetStateAction<string | null>>;
  setForeground: Dispatch<SetStateAction<ReaderForeground>>;
  setShelfBusy: Dispatch<SetStateAction<boolean>>;
  setShelfBusyMessage: Dispatch<SetStateAction<string>>;
  setShelfEntries: Dispatch<SetStateAction<ShelfEntry[]>>;
  setShelfError: Dispatch<SetStateAction<string | null>>;
  setShelfNotice: ShelfNoticeSetter;
  setProgressChoice: Dispatch<SetStateAction<{ title: string; candidates: readonly PortableProgressChoiceCandidate[] } | null>>;
  setLocalCheckpointConflict: Dispatch<SetStateAction<{ title: string; hasSynced: boolean } | null>>;
  setSaveFailurePrompt: Dispatch<SetStateAction<SaveFailurePrompt | null>>;
  shelfBusyRef: MutableRefObject<boolean>;
  shelfEntriesRef: MutableRefObject<ShelfEntry[]>;
  persistShelfProgressRef: MutableRefObject<(explicit?: boolean) => void>;
  noteBusyRef: MutableRefObject<boolean>;
  latestPreciseRequestRef: MutableRefObject<number | null>;
  preciseRequestRef: MutableRefObject<number>;
  progressChoiceResolverRef: MutableRefObject<((stamp: Stamp | null) => void) | null>;
  localCheckpointResolverRef: MutableRefObject<((choice: "local" | "synced" | null) => void) | null>;
  scrubSessionRef: ScrubState["scrubSessionRef"];
  tocFollowSeekRef: ScrubState["tocFollowSeekRef"];
  sidebarNavigationMemoryRef: MutableRefObject<SidebarNavigationMemory>;
  lastStablePositionRef: MutableRefObject<ReaderHistoryPosition>;
  activeProgressLeaseRef: ProgressRuntime["activeProgressLeaseRef"];
  localCheckpointsRef: ProgressRuntime["localCheckpointsRef"];
  firstSampleFailureRecordedRef: ProgressRuntime["firstSampleFailureRecordedRef"];
  progressWriterRef: ProgressRuntime["progressWriterRef"];
  closeForeground: ReturnType<typeof useReaderForeground>["closeForeground"];
  closeImageOverlay: () => void;
  dispatchReaderSession: ReaderSessionHost["dispatchReaderSession"];
  startRestore: ReaderSessionHost["startRestore"];
  dispatchScrub: ScrubState["dispatchScrub"];
  ensureProgressRuntimeReady: ProgressRuntime["ensureProgressRuntimeReady"];
  retainUnsavedSample: ProgressRuntime["retainUnsavedSample"];
  recordLifecycleDiagnostic: ProgressRuntime["recordLifecycleDiagnostic"];
  persistShelfProgress: ProgressCommit["persistShelfProgress"];
  persistChapterCountCache: ProgressCommit["persistChapterCountCache"];
  reimportAndroidMissing: BookImport["reimportAndroidMissing"];
  showReaderNotice: (text: string, kind?: "ok" | "warn" | "error") => void;
  runtime: ReturnType<typeof getRuntimeCapabilities>;
  isTauriEnv: () => boolean;
  toPersistedReaderAnchor: ToPersistedReaderAnchor;
  bookKeyOf: (b: Book, name: string, size: number) => string;
  firstLinear: (b: Book) => number;
  clamp: (v: number, lo: number, hi: number) => number;
  legacySavedProgress: (entry: ShelfEntry) => SavedProgress;
  savedProgressFromPortableLocator: (book: Book, locator: Locator, fallback: SavedProgress) => SavedProgress;
  savedProgressFromShelfEntry: (book: Book, entry: ShelfEntry) => SavedProgress;
  savedProgressFromVersion: (book: Book, version: Version<ProgressValue>) => SavedProgress;
  mergeProgressProjection: (entry: ShelfEntry, written: ShelfEntry) => ShelfEntry;
  portableProgressVersions: (entry: ShelfEntry) => readonly Version<ProgressValue>[];
  sameCheckpointPatchValue: (patch: ShelfProgressPatch, version: Version<ProgressValue>) => boolean;
}): BookOpenActions {
  // ---- 打开书（书架导入/书架打开共用；只承载阅读器状态，不改渲染核心） ----
  const openParsedBook = useCallback(
    (
      b: Book,
      srv: ResourceServer,
      fileName: string,
      fileSize: number,
      savedOverride: SavedProgress | null,
      shelfId: string | null,
      countCacheKey: string | null,
      baselineProgressPct: number,
      freshTextProfile = false
    ) => {
      if (activeSessionRef.current && activeSessionRef.current.server !== srv) {
        activeSessionRef.current.server.revokeAll();
        disposeBook(activeSessionRef.current.book);
      }
      const key = bookKeyOf(b, fileName, fileSize);
      const saved = savedOverride ?? readProgress(key);
      const generation = ++sessionGenerationRef.current;
      activeSessionRef.current = {
        generation,
        book: b,
        server: srv,
        bookKey: key,
        countCacheKey,
        structuralCounts: createChapterCountCollection(generation, b.spine.map((item) => item.linear)),
      };
      const linearMask = b.spine.map((item) => item.linear);
      let counts = createChapterCountCollection(
        generation,
        linearMask
      );
      const cached = freshTextProfile ? [] : readCachedChapterCounts(countCacheKey, linearMask);
      for (const [index, value] of cached) {
        counts = applyChapterCount(counts, generation, index, value, "estimated").collection;
      }
      if (b.sourceFormat === "comic-zip") {
        counts = applyChapterCount(counts, generation, 0, (b.comicPages?.length ?? 0) * 1000, "estimated").collection;
      }
      activeSessionRef.current.structuralCounts = counts;
      chapterCountsRef.current = counts;
      setChapterCountsState(chapterCountsRef.current);
      baselineProgressPctRef.current =
        Number.isSafeInteger(baselineProgressPct) && baselineProgressPct >= 0
          ? Math.min(100, baselineProgressPct)
          : 0;
      lastCountProgressSignatureRef.current = null;
      contentAxisRef.current = null;
      setContentAxis(null);
      scrubSessionRef.current += 1;
      tocFollowSeekRef.current = null;
      sidebarNavigationMemoryRef.current.tocFollow = undefined;
      dispatchScrub({ type: "reset", session: scrubSessionRef.current });
      const start = clamp(saved?.spineIndex ?? firstLinear(b), 0, b.spine.length - 1);
      setBook(b);
      setServer(srv);
      setBookKey(key);
      setRuntimeIssues([]);
      setChapterState({ status: "loading" });
      setSpineIndex(start);
      setAnchor(undefined);
      setInitialPage(saved?.page ?? 0);
      setInitialAnchor(toPersistedReaderAnchor(saved?.anchor));
      // 没有正文/元素/媒体目标（新书、章首、旧页码、固定版式）：按正常开章结算。
      startRestore(generation, spineItemPath(b, start) ?? "", b.fixedLayout || !toPersistedReaderAnchor(saved?.anchor));
      lastStablePositionRef.current = {
        spineIndex: start,
        page: saved?.page ?? 0,
        anchor: toPersistedReaderAnchor(saved?.anchor),
      };
      dispatchReaderSession({ type: "open" });
      setCurrentShelfId(shelfId);
      setReaderHistory(emptyReaderNavigationHistory());
      setForeground(closeReaderForeground());
      setSearchQuery("");
      setNoteBusy(false);
      noteBusyRef.current = false;
      setView("reader");
      setPhase({ phase: "ready" });
    },
    []
  );

  // ---- 从书架打开 ----
  const handleShelfOpen = useCallback(
    async (
      id: string,
      searchTarget?: ResolvedCrossBookSearchHit,
      searchTextHits?: ExactTextHit[],
      searchOccurrence?: SearchOccurrence,
      textEncodingOverride?: string,
    ) => {
      if (shelfBusyRef.current) return;
      const cardEntry = shelfEntriesRef.current.find((e) => e.id === id);
      if (!cardEntry) return;
      // Acquire the single-operation guard before the first await, including
      // readiness recovery and any user position-choice dialog.
      shelfBusyRef.current = true;
      setShelfBusyMessage(uiText("notice.open.opening"));
      setShelfBusy(true);
      let preparationStage = "check";
      const store = getShelfStore();
      const writer = progressWriterRef.current!;
      try {
      // A real health response, not an event or cached promise, gates opening.
      // Check the first read too; recover only after an explicit not-ready result.
      try {
        await ensureProgressRuntimeReady();
      } catch (error) {
        recordLifecycleDiagnostic("open_failed", {
          stage: "check",
          result: "failed",
          errorCode: (error as { readonly code?: unknown } | null)?.code as string | undefined,
        });
        setShelfNotice({ kind: "error", text: bookOpenErrorMessage(error) });
        return;
      }
      persistShelfProgressRef.current(true);
      const previousLease = activeProgressLeaseRef.current;
      const targetLane = writer.current(id);
      const openPlan = await planFreshProgressOpen({
        flushTarget: async () => {
          preparationStage = "flush";
          return targetLane ? writer.flush(targetLane) : null;
        },
        readCurrent: async () => {
          preparationStage = "read-current";
          if (store.readProgressEntryForOpen) return store.readProgressEntryForOpen(id);
          const entries = await store.list();
          const entry = entries.find((item) => item.id === id);
          if (!entry) throw Object.assign(new Error("书架中没有这本书"), {
            code: "shelf-record-missing", recordsCount: entries.length, targetFound: false,
          });
          return entry;
        },
        choose: async (originalEntry) => {
          preparationStage = "choose";
          // B3: bind a specific progress version even when there is only one
          // candidate. The same selection is adopted against the repository read
          // before the EPUB is parsed.
          let chosenProgressVersion: Version<ProgressValue> | null = null;
          let progressSelection: PortableProgressSelection | null = null;
          let checkpointAckPending: LocalProgressCheckpoint<ShelfProgressPatch> | null = null;
          let checkpointPatchToRestore: LocalProgressCheckpoint<ShelfProgressPatch> | null = null;
          let explicitPositionChoice = false;
          const progressVersions = portableProgressVersions(originalEntry);
          const checkpointBookHash = originalEntry.contentHash ?? id;
          let checkpointForOpen: LocalProgressCheckpoint<ShelfProgressPatch> | null = null;
          try {
            checkpointForOpen = localCheckpointsRef.current?.peek(checkpointBookHash) ?? null;
          } catch (error) {
            setShelfNotice({ kind: "warn", text: uiText("notice.open.checkpointReadFailed", { error: String(error) }) });
          }
          if (checkpointForOpen) {
            const plan = planCheckpointOpen(checkpointForOpen, progressVersions, sameCheckpointPatchValue);
            if (plan.kind === "use-saved") {
              chosenProgressVersion = plan.version;
              progressSelection = { kind: "chosen", stamp: plan.version.stamp };
              checkpointAckPending = checkpointForOpen;
            } else if (plan.kind === "restore-local") {
              // The displayed basis remains valid, but the local sample still has
              // to be written through that basis before the checkpoint can be acked.
              checkpointPatchToRestore = plan.checkpoint;
              chosenProgressVersion = plan.basis;
              progressSelection = plan.basis
                ? { kind: "chosen", stamp: plan.basis.stamp }
                : { kind: "empty" };
            } else {
              const latest = latestVersion(progressVersions);
              const choice = await new Promise<"local" | "synced" | null>((resolve) => {
                localCheckpointResolverRef.current = resolve;
                setLocalCheckpointConflict({ title: originalEntry.title, hasSynced: progressVersions.length > 0 });
              });
              localCheckpointResolverRef.current = null;
              setLocalCheckpointConflict(null);
              if (!choice) return null;
              explicitPositionChoice = true;
              if (choice === "local") {
                checkpointPatchToRestore = checkpointForOpen;
                chosenProgressVersion = latest;
                progressSelection = latest
                  ? { kind: "chosen", stamp: latest.stamp }
                  : { kind: "empty" };
              } else {
                setShelfNotice({
                  kind: "warn",
                  text: uiText("notice.open.syncedPosition"),
                });
              }
            }
          }
          if (!progressSelection) {
            if (progressVersions.length > 1) {
              const candidates = [...progressVersions]
                .sort((left, right) => compareStamp(left.stamp, right.stamp))
                .map((version): PortableProgressChoiceCandidate => {
                  const projection = projectProgressVersion(version);
                  return {
                    key: `${version.stamp.deviceId}:${version.stamp.counter}`,
                    deviceId: version.stamp.deviceId,
                    stamp: version.stamp,
                    version,
                    progressPct: projection.value?.progressPctHint ?? 0,
                    updatedAtMs: version.updatedAtMs,
                  };
                });
              const selectedStamp = await new Promise<Stamp | null>((resolve) => {
                progressChoiceResolverRef.current = resolve;
                setProgressChoice({ title: originalEntry.title, candidates });
              });
              progressChoiceResolverRef.current = null;
              setProgressChoice(null);
              if (!selectedStamp) return null;
              chosenProgressVersion = versionForStamp(progressVersions, selectedStamp);
              if (!chosenProgressVersion) {
                setShelfNotice({ kind: "error", text: uiText("notice.open.versionGone") });
                return null;
              }
              explicitPositionChoice = true;
              // ER-0139: settle the choice so the other shown versions stop
              // reappearing. On any mismatch or failure, open once as before.
              const resolved = await store.resolveProgressChoice?.(
                id, chosenProgressVersion, candidates.map((candidate) => candidate.stamp),
              ).catch(() => null) ?? null;
              if (resolved) chosenProgressVersion = resolved;
              progressSelection = { kind: "chosen", stamp: chosenProgressVersion.stamp };
            } else if (progressVersions.length === 1) {
              chosenProgressVersion = progressVersions[0];
              progressSelection = { kind: "chosen", stamp: progressVersions[0].stamp };
            } else {
              progressSelection = { kind: "empty" };
            }
          }
          return { chosenProgressVersion, progressSelection, checkpointAckPending,
            checkpointPatchToRestore, explicitPositionChoice };
        },
      });
      if (!openPlan) return;
      const originalEntry = openPlan.entry;
      const { chosenProgressVersion, progressSelection, checkpointAckPending,
        checkpointPatchToRestore } = openPlan.decision;
      if (!progressSelection) return;
      shelfBusyRef.current = true;
      setShelfBusyMessage(uiText("notice.open.opening"));
      setShelfBusy(true);
      setShelfError(null);
      if (searchTarget) setSearchNavigationBusy(true);
      setPhase({
        phase: "loading",
        fileName: originalEntry.fileName,
        title: originalEntry.title,
        creator: originalEntry.creator,
      });
      let preciseRequestId: number | null = null;
      let unownedBook: Book | null = null;
      let unownedArchive: ArchiveClient | null = null;
      let candidateLease: ProgressLease | null = null;
      let candidateActivated = false;
      const targetSavedLease = openPlan.targetSave?.status === "saved" ? targetLane : null;
      const targetHandoffLease = openPlan.targetSave?.status === "failed" ? targetLane : null;
      let previousSavedLease: ProgressLease | null = null;
      let openStage: "check" | "flush" | "readSource" | "openArchive" | "begin" | "parse" | "publish" = "check";
      try {
        openStage = "flush";
        // A different paused book may be flushed opportunistically; failure
        // keeps its lane/lease/checkpoint and does not abort this open.
        if (previousLease && previousLease !== targetLane && previousLease.bookId !== id) {
          const saved = await writer!.flush(previousLease);
          if (saved.status === "saved") {
            previousSavedLease = previousLease;
          } else {
            setShelfNotice({
              kind: "warn",
              text: uiText("notice.open.previousUnsaved"),
            });
          }
        }
        let entry = originalEntry;
        // A document link is only found missing by opening it: the record stays
        // "available", so the shelf's own mark from the failed open decides.
        const originalMissing = runtime.platform === "android" && entry.originalLocation === true &&
          shelfEntriesRef.current.find((item) => item.id === id)?.available === false;
        if (entry.available === false || originalMissing) {
          if (runtime.platform === "android") {
            const restored = await reimportAndroidMissing(entry);
            if (!restored) {
              shelfBusyRef.current = false;
              setShelfBusy(false);
              setPhase({ phase: "idle" });
              setSearchNavigationBusy(false);
              return;
            }
            entry = restored;
          } else if (isTauriEnv()) {
            const selected = await openFileDialog({
              multiple: false,
              directory: false,
              title: uiText("notice.open.relocateTitle", { title: entry.title }),
              filters: [{ name: uiText("notice.picker.epubFilter"), extensions: bookPickerExtensions() }],
            });
            if (!selected || Array.isArray(selected)) {
              shelfBusyRef.current = false;
              setShelfBusy(false);
              setPhase({ phase: "idle" });
              setSearchNavigationBusy(false);
              return;
            }
            entry = await getShelfStore().relink(id, selected);
            setShelfEntries((prev) =>
              prev.map((item) => (item.id === id ? entry : item))
            );
          }
        }
        const openArchive = isTauriEnv() && (store.archiveOnly || runtime.platform === "android" || sourceFormat(entry.fileName) !== "epub")
          ? store.openArchive?.bind(store)
          : undefined;
        const chosenProjection = chosenProgressVersion
          ? projectProgressVersion(chosenProgressVersion)
          : null;
        const initialSpineIndex = searchTarget
          ? searchTarget.spineIndex
          : (chosenProjection?.spineIndex ?? entry.spineIndex ?? 0);
        let b: Book;
        if (openArchive) {
          openStage = "openArchive";
          const sourceEncoding = sourceFormat(entry.fileName) === "txt"
            ? textEncodingOverride || textEncodingFromPath((chosenProgressVersion ? projectProgressVersion(chosenProgressVersion).chapterPath : (entry as { chapterPath?: string }).chapterPath)) || shelfSpaceStorage.getItem(`epub-reader:txt-encoding:${id}`)
            : undefined;
          const archive = await openArchive(id, sourceEncoding || undefined).catch((error) => {
            if (describeBookOpenFailure(error).sourceUnavailable) {
              setShelfEntries((prev) =>
                prev.map((item) => (item.id === id ? { ...item, available: false } : item))
              );
            }
            throw error;
          });
          unownedArchive = archive;
          openStage = "begin";
          // B3: prepare, but do not publish, the selected progress candidate.
          candidateLease = store.prepareProgressSession
            ? await store.prepareProgressSession(id, progressSelection)
            : null;
          if (!candidateLease && store.beginProgressSession) {
            await store.beginProgressSession(id, progressSelection);
          }
          b = await loadSourceArchive(archive, entry.fileName, { initialSpineIndex });
          unownedArchive = null;
          openStage = "parse";
        } else {
          openStage = "readSource";
          let buf: Uint8Array;
          try {
            buf = await store.readBook(id);
          } catch (error) {
            if (describeBookOpenFailure(error).sourceUnavailable) {
              setShelfEntries((prev) =>
                prev.map((item) => (item.id === id ? { ...item, available: false } : item))
              );
            }
            throw error;
          }
          // Legacy browser shelf IDs may be UUIDs; index identity always comes from EPUB bytes.
          if (IS_AI_EDITION && !isTauriEnv() && !/^[a-f0-9]{64}$/.test(entry.contentHash ?? "")) {
            entry = await store.setContentHash(id, await sha256Hex(buf));
            setShelfEntries((prev) => prev.map((item) => item.id === id ? entry : item));
          }
          openStage = "begin";
          // B3: prepare, but do not publish, the selected progress candidate.
          candidateLease = store.prepareProgressSession
            ? await store.prepareProgressSession(id, progressSelection)
            : null;
          if (!candidateLease && store.beginProgressSession) {
            await store.beginProgressSession(id, progressSelection);
          }
          openStage = "parse";
          b = await loadSourceBook(buf, entry.fileName, { selective: true, initialSpineIndex }, textEncodingOverride || textEncodingFromPath(chosenProgressVersion ? projectProgressVersion(chosenProgressVersion).chapterPath : (entry as {chapterPath?: string}).chapterPath) || shelfSpaceStorage.getItem(`epub-reader:txt-encoding:${id}`) || undefined);
        }
        // 在 openParsedBook 正式接管前，Book 仍由本函数负责释放；
        // 后面的空 spine / 进度解析 / 目标校验等任何失败路径都不能漏掉。
        unownedBook = b;
        if (b.spine.length === 0) {
          throw new Error("这本书没有可阅读的内容");
        }
        const srv = new ResourceServer(b);
        let saved: SavedProgress;
        if (textEncodingOverride !== undefined) {
          saved = { spineIndex: 0, page: 0, anchor: null };
        } else if (searchTarget) {
          let targetIndex = searchTarget.spineIndex;
          if (spineItemPath(b, targetIndex) !== searchTarget.chapterPath) {
            targetIndex = spineIndexForEntryKey(b, searchTarget.chapterPath);
          }
          if (targetIndex < 0 || targetIndex >= b.spine.length) {
            throw new Error("索引结果对应的章节已不存在，请重建该书索引");
          }
          preciseRequestId = ++preciseRequestRef.current;
          saved = {
            spineIndex: targetIndex,
            page: 0,
            anchor: {
              index: -1,
              ratio: 0,
              anchorTextOffset: searchTarget.textAnchor.start,
              anchorTextSnippet: searchTarget.textAnchor.snippet || null,
            },
          };
        } else if (checkpointPatchToRestore) {
          const patch = checkpointPatchToRestore.patch;
          const patchEntry = {
            ...entry,
            spineIndex: patch.spineIndex,
            page: patch.page,
            anchorIndex: patch.anchorIndex,
            anchorRatio: patch.anchorRatio,
            anchorTextOffset: patch.anchorTextOffset,
            anchorTextSnippet: patch.anchorTextSnippet,
            mediaAnchor: patch.mediaAnchor ?? null,
          } as ShelfEntry;
          const patchValue = progressValueFromPatch(patch);
          saved = patchValue
            ? savedProgressFromPortableLocator(b, patchValue.locator, legacySavedProgress(patchEntry))
            : legacySavedProgress(patchEntry);
        } else if (chosenProgressVersion) {
          saved = savedProgressFromVersion(b, chosenProgressVersion);
        } else {
          saved = savedProgressFromShelfEntry(b, entry);
        }
        openStage = "publish";
        // Takeover: the parsed candidate is now published and its exact lease
        // owns the writer lane. Old saved lanes are retired only now; failures
        // before this point leave the previous reader/session intact.
        if (candidateLease) {
          if (targetHandoffLease) {
            const checkpoints = localCheckpointsRef.current;
            if (!checkpoints) throw new Error("本机进度检查点不可用");
            const handoffHash = store.progressSessionBookHash?.(targetHandoffLease) ?? (entry.contentHash ?? id);
            const handoffStamp = store.progressSessionChosenStamp?.(targetHandoffLease) ?? null;
            writer!.handoffToCheckpoint(targetHandoffLease, (sample) => {
              // retain must durably stage before removing the old lane. Do not
              // acknowledge or clear the old checkpoint here.
              stageCheckpointSample(checkpoints, handoffHash, handoffStamp, sample.patch);
            });
            await store.closeProgressLease?.(targetHandoffLease);
            if (activeProgressLeaseRef.current === targetHandoffLease) {
              activeProgressLeaseRef.current = null;
            }
          }
          if (targetSavedLease) {
            writer!.retire(targetSavedLease);
            await store.closeProgressLease?.(targetSavedLease);
            if (activeProgressLeaseRef.current === targetSavedLease) {
              activeProgressLeaseRef.current = null;
            }
          }
          if (previousSavedLease) {
            writer!.retire(previousSavedLease);
            await store.closeProgressLease?.(previousSavedLease);
            if (activeProgressLeaseRef.current === previousSavedLease) {
              activeProgressLeaseRef.current = null;
            }
          }
          store.activateProgressSession?.(candidateLease);
          const sessionBookHash = store.progressSessionBookHash?.(candidateLease) ?? (entry.contentHash ?? id);
          const leaseForWriter = candidateLease;
          progressWriterRef.current?.register(leaseForWriter, async (sample) => {
            try {
              const checkpoints = localCheckpointsRef.current;
              if (!checkpoints) throw new Error("本机进度检查点不可用");
              const saved = await persistCheckpointSample(
                checkpoints,
                sessionBookHash,
                sample,
                async (patch) => {
                  const result = await store.updateProgressForSession?.(leaseForWriter, patch);
                  if (!result) throw new Error("当前后端不支持精确进度会话写入");
                  return result;
                },
              );
              setShelfEntries((prev) =>
                prev.map((item) => item.id === id ? mergeProgressProjection(item, saved.entry) : item)
              );
            } catch (error) {
              if (!firstSampleFailureRecordedRef.current) {
                firstSampleFailureRecordedRef.current = true;
                recordLifecycleDiagnostic("sample_failed", {
                  stage: "flush",
                  result: "failed",
                  candidate: true,
                  repositoryGeneration: store.progressSessionRepositoryGeneration?.(leaseForWriter),
                  errorCode: (error as { readonly code?: unknown } | null)?.code as string | undefined,
                });
              }
              throw error;
            }
          });
        }
        // 第一次打开：立即清除“新”标记（后端落盘异步完成，不阻塞阅读）
        if (entry.isNew) {
          setShelfEntries((prev) => markShelfEntryOpened(prev, id));
          void getShelfStore()
            .markOpened(id)
            .then(() => setShelfEntries((prev) => markShelfEntryOpened(prev, id)))
            .catch(() => {
              /* 下次打开时再尝试清除 */
            });
        }
        openParsedBook(
          b,
          srv,
          entry.fileName,
          entry.fileSize,
          saved,
          id,
          entry.contentHash ?? id,
          openingBaselinePct(
            checkpointPatchToRestore?.patch ?? null,
            chosenProgressVersion ? projectProgressVersion(chosenProgressVersion).value?.progressPctHint : undefined,
            chosenProgressVersion !== null,
            entry.progressPct,
          ),
          textEncodingOverride !== undefined,
        );
        if (candidateLease) {
          activeProgressLeaseRef.current = candidateLease;
          candidateActivated = true;
          if (checkpointPatchToRestore) {
            // Explicit local conflict resolution: stage/write the retained local
            // position through the newly published exact session.
            const checkpoints = localCheckpointsRef.current;
            const restoreBookHash = store.progressSessionBookHash?.(candidateLease) ?? (entry.contentHash ?? id);
            if (checkpoints) {
              const shownStamp = store.progressSessionChosenStamp?.(candidateLease) ?? null;
              const sample = stageCheckpointSample(
                checkpoints,
                restoreBookHash,
                shownStamp,
                checkpointPatchToRestore.patch,
              );
              progressWriterRef.current?.enqueue(candidateLease, sample);
            }
          }
        }
        if (checkpointAckPending) {
          try {
            localCheckpointsRef.current?.acknowledge(checkpointAckPending.bookHash, checkpointAckPending.checkpointId);
          } catch {
            /* 保留记录，下一次打开继续核对。 */
          }
        }
        unownedBook = null;
        if (preciseRequestId !== null && searchTarget) {
          latestPreciseRequestRef.current = preciseRequestId;
          setInitialPage(null);
          setPreciseTarget({
            requestId: preciseRequestId,
            kind: "search",
            chapterPath: searchTarget.chapterPath,
            textHits: searchTextHits,
            occurrence: searchOccurrence,
          });
        }
        shelfBusyRef.current = false;
        setShelfBusy(false);
      } catch (e) {
        const failure = describeBookOpenFailure(e);
        recordLifecycleDiagnostic("open_failed", {
          stage: openStage,
          result: "failed",
          candidate: candidateLease !== null,
          repositoryGeneration: candidateLease
            ? store.progressSessionRepositoryGeneration?.(candidateLease)
            : undefined,
          errorCode: (e as { readonly code?: unknown } | null)?.code as string | undefined,
        });
        if (activeSessionRef.current && activeProgressLeaseRef.current) {
          // A failed second-open must not replace the still-valid old reader
          // with the loading/error body.
          setPhase({ phase: "ready" });
          showReaderNotice(uiText("notice.open.failed", { error: failure.message }), "error");
        } else {
          setShelfError(uiText("notice.open.failed", { error: failure.message }));
          setPhase({ phase: "error", message: failure.message });
        }
        setSearchNavigationBusy(false);
      } finally {
        // Close only the candidate acquired by this operation. This covers
        // throw, empty-spine return and cancel before publication.
        if (candidateLease && !candidateActivated) {
          try {
            progressWriterRef.current?.retire(candidateLease);
          } catch {
            /* Not registered yet, or no writer lane remains. */
          }
          await store.closeProgressLease?.(candidateLease).catch(() => undefined);
          if (activeProgressLeaseRef.current === candidateLease) {
            activeProgressLeaseRef.current = null;
          }
        }
        // 进度初始化可能在 loader 接管前失败，此时由开书入口关闭原生归档。
        unownedArchive?.close();
        // openParsedBook 返回后所有权已归 App 会话；若它在中途抛错但已写入
        // activeSessionRef，则不再抢占销毁，避免把正在阅读的 Book 释放掉。
        if (unownedBook && activeSessionRef.current?.book !== unownedBook) {
          disposeBook(unownedBook);
        }
      }
      } catch (error) {
        const detail = error as { code?: string; recordsCount?: number; targetFound?: boolean };
        recordLifecycleDiagnostic("open_failed", {
          stage: preparationStage, result: "failed", errorCode: detail?.code,
          count: detail?.recordsCount, targetFound: detail?.targetFound,
        });
        setShelfNotice({ kind: "error", text: uiText("notice.open.failed", { error: describeBookOpenFailure(error).message }) });
      } finally {
        shelfBusyRef.current = false;
        setShelfBusy(false);
      }
    },
    [openParsedBook, reimportAndroidMissing, recordLifecycleDiagnostic, showReaderNotice, ensureProgressRuntimeReady]
  );

  /** `animate`: the user is going back to the library, not switching books through it. */
  const leaveReader = useCallback(async (leaveUnsaved: boolean, animate = false, covered?: Promise<void>): Promise<boolean> => {
    // 返回书架前先关浮层，再释放整本书的 ResourceServer。
    closeImageOverlay();
    persistShelfProgress(true);
    recordLifecycleDiagnostic("back_to_shelf", { stage: "save", result: leaveUnsaved ? "leave-unsaved" : "begin" });
    shelfBusyRef.current = true;
    setShelfBusyMessage(uiText("notice.progress.saving"));
    setShelfBusy(true);
    let outcome = "saved";
    try {
      const lease = activeProgressLeaseRef.current;
      if (lease) {
        const saved = await progressWriterRef.current?.flush(lease);
        if (saved?.status === "failed") {
          if (!leaveUnsaved) throw saved.error;
          // Explicit user choice after a failed save: never block leaving.
          // The sample moves to the local checkpoint; if even that cannot
          // run, the lane stays paused and a later open/close retries it.
          const writer = progressWriterRef.current!;
          if (releaseUnsavedLane(writer, lease, retainUnsavedSample(lease)) === "checkpoint") {
            await getShelfStore().closeProgressLease?.(lease).catch(() => undefined);
            activeProgressLeaseRef.current = null;
          }
          setShelfError(uiText("notice.progress.saveFailed", { error: String(saved.error) }));
          outcome = "left-unsaved";
        } else {
          progressWriterRef.current?.retire(lease);
          await getShelfStore().closeProgressLease?.(lease);
          activeProgressLeaseRef.current = null;
        }
      }
      persistChapterCountCache();
      recordLifecycleDiagnostic("back_to_shelf", { stage: "save", result: outcome });
    } catch (error) {
      recordLifecycleDiagnostic("back_to_shelf", {
        stage: "save",
        result: "failed",
        errorCode: (error as { readonly code?: unknown } | null)?.code as string | undefined,
      });
      setSaveFailurePrompt({ kind: "shelf", error: String(error) });
      shelfBusyRef.current = false;
      setShelfBusy(false);
      return false;
    }
    const switchToShelf = (): void => {
      closeForeground();
      setSearchQuery("");
      setDiagText(null);
      chapterCountJobRef.current?.cancel();
      chapterCountJobRef.current = null;
      sessionGenerationRef.current++;
      activeSessionRef.current = null;
      if (bookRef.current) {
        disposeBook(bookRef.current);
        bookRef.current = null;
      }
      setCurrentShelfId(null);
      // Final progress is committed above; this is the sync's "left the reader" moment.
      noteCloudSyncChange("reader-closed");
      // 只先切换视图。下一次 React 提交会卸载 ReaderView；ReaderView cleanup
      // 先 dispose paginator、再 revoke ResourceServer，随后会话清理 effect
      // 才清空 book/server 等状态，避免 iframe 仍在读资源时提前撤销。
      setView("shelf");
      shelfBusyRef.current = false;
      setShelfBusy(false);
    };
    // The reader page lifts away over the library. The snapshot is taken before
    // switchToShelf tears anything down, so the old page is the one the user saw.
    // 切标签：等下一本的开书画面完全浮出再换下面的视图。
    if (covered) await covered;
    if (animate) await runPageTransition("back", switchToShelf);
    else switchToShelf();
    return true;
  }, [persistShelfProgress, persistChapterCountCache, closeForeground, closeImageOverlay, retainUnsavedSample]);

  return { openParsedBook, handleShelfOpen, leaveReader };
}
