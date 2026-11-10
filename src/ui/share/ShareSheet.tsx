import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Segmented } from "../controls/Segmented";
import { CloseIcon } from "../readerIcons";
import { useScrollEdgeFade } from "../scrollEdgeFade";
import { useUiText } from "../localization/UiLanguageProvider";
import type { ShareDraft } from "../readerForeground";
import { coverToneFromImage } from "./coverTone";
import { canUseVertical, FALLBACK_COVER_TONE, shareCardPalette, type ShareCardContent, type ShareTemplate } from "./shareCardModel";
import { drawShareCard, shareCardHeight, shareCardPng } from "./shareCardRenderer";
import { useShareOptions } from "./shareOptions";
import {
  canCopyImage, copyShareImage, copyShareText, saveShareImage, saveShareImageToGallery, shareActions, shareFileName,
  shareImageNative, type ShareActionId, type ShareSurface,
} from "./shareOutput";
import { formatShareCitation, splitSentences, tidyPassage } from "./shareText";
import "./shareSheet.css";

export interface ShareSheetBook {
  title: string;
  author?: string;
  chapter?: string;
  /** An object URL of the cover thumbnail, when one is cached. */
  coverUrl?: string | null;
}

export interface ShareSheetProps {
  draft: ShareDraft;
  book: ShareSheetBook;
  surface: ShareSurface;
  onClose(): void;
  onNotice(text: string, kind: "ok" | "warn" | "error"): void;
}

/**
 * The share panel (ER-0119): a live card preview drawn by the same renderer
 * that exports the PNG, the card choices, and the platform's share actions.
 * A centred dialog on desktop, a bottom sheet on phones (CSS only).
 */
export function ShareSheet({ draft, book, surface, onClose, onNotice }: ShareSheetProps) {
  const { t } = useUiText();
  const { shareOptions: options, updateShareOptions } = useShareOptions();
  const passage = useMemo(() => tidyPassage(draft.quote), [draft.quote]);
  const sentences = useMemo(() => splitSentences(passage), [passage]);
  const [kept, setKept] = useState(sentences.length);
  // A long card grows with its text, so it always carries the whole passage (ER-0162).
  const long = options.ratio === "long";
  const shown = long ? sentences.length : Math.max(1, kept);
  const quote = sentences.slice(0, shown).join("").trim();
  const hasNote = draft.note.trim().length > 0;
  const verticalAllowed = canUseVertical(passage, options.ratio);

  const [cover, setCover] = useState<HTMLImageElement | null>(null);
  const [coverTone, setCoverTone] = useState<string | null>(null);
  useEffect(() => {
    if (!book.coverUrl) return;
    let live = true;
    const image = new Image();
    image.onload = () => {
      if (!live) return;
      setCover(image);
      setCoverTone(coverToneFromImage(image));
    };
    image.src = book.coverUrl;
    return () => { live = false; };
  }, [book.coverUrl]);

  const content: ShareCardContent = useMemo(() => ({
    quote, note: draft.note, bookTitle: book.title, author: book.author, chapter: book.chapter, accent: draft.accent,
  }), [quote, draft.note, draft.accent, book.title, book.author, book.chapter]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  useScrollEdgeFade(stageRef, long);
  useLayoutEffect(() => {
    if (stageRef.current) stageRef.current.scrollTop = 0;
  }, [options.ratio]);
  const [truncated, setTruncated] = useState(false);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const assets = { cover, coverTone };
    const height = shareCardHeight(ctx, content, options, assets);
    if (canvas.width !== 1080) canvas.width = 1080;
    if (canvas.height !== height) canvas.height = height;
    const result = drawShareCard(ctx, content, options, assets);
    setTruncated(result.truncated);
  }, [content, options, cover, coverTone]);

  const [copyImageFailed, setCopyImageFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const actions = shareActions(surface, { clipboardImage: canCopyImage() && !copyImageFailed });

  const run = async (action: ShareActionId) => {
    if (busy) return;
    setBusy(true);
    try {
      const fileName = shareFileName(book.title);
      const png = action === "copyText" ? null : await shareCardPng(canvasRef.current!);
      switch (action) {
        case "copyText":
          await copyShareText(formatShareCitation(content, { showChapter: options.showChapter }));
          onNotice(t("share.done.copyText"), "ok");
          break;
        case "copyImage":
          try {
            await copyShareImage(png!);
            onNotice(t("share.done.copyImage"), "ok");
          } catch (error) {
            setCopyImageFailed(true);
            throw error;
          }
          break;
        case "saveImage":
          if (await saveShareImage(png!, fileName, surface, { title: t("share.action.saveImage"), filter: t("share.filter") })) {
            onNotice(t("share.done.saved"), "ok");
          }
          break;
        case "saveGallery":
          await saveShareImageToGallery(png!, fileName);
          onNotice(t("share.done.gallery"), "ok");
          break;
        case "share":
          await shareImageNative(png!, fileName, formatShareCitation(content, { showChapter: options.showChapter }));
          break;
      }
    } catch (error) {
      onNotice(t("share.failed", { error: error instanceof Error ? error.message : String(error) }), "error");
    } finally {
      setBusy(false);
    }
  };

  const templates: { id: ShareTemplate; label: string }[] = [
    { id: "paper", label: t("share.template.paper") },
    { id: "cover", label: t("share.template.cover") },
    { id: "night", label: t("share.template.night") },
    { id: "vertical", label: t("share.template.vertical") },
  ];
  const activeTemplate = options.template === "vertical" && !verticalAllowed ? "paper" : options.template;
  const toggles: { key: "showNote" | "showCover" | "showChapter" | "showBrand"; label: string; disabled?: boolean }[] = [
    { key: "showNote", label: t("share.toggle.note"), disabled: !hasNote },
    { key: "showCover", label: t("share.toggle.cover"), disabled: !book.coverUrl },
    { key: "showChapter", label: t("share.toggle.chapter"), disabled: !book.chapter },
    { key: "showBrand", label: t("share.toggle.brand") },
  ];
  const actionLabel: Record<ShareActionId, string> = {
    copyText: t("share.action.copyText"),
    copyImage: t("share.action.copyImage"),
    saveImage: t("share.action.saveImage"),
    saveGallery: t("share.action.saveGallery"),
    share: t("share.action.share"),
  };

  return (
    <>
      <div className="share-backdrop" aria-hidden="true" onClick={onClose} />
      <div className="share-sheet" role="dialog" aria-modal="true" aria-labelledby="share-sheet-title">
        <div className="share-head">
          <span className="share-grabber" aria-hidden="true" />
          <b id="share-sheet-title">{t("share.title")}</b>
          <button type="button" className="ui-quiet-btn share-close" aria-label={t("share.close")} title={t("share.close")} onClick={onClose}>
            <CloseIcon size={14} />
          </button>
        </div>

        <div ref={stageRef} className="share-stage scrollbar-hidden" data-long={long || undefined}>
          <canvas ref={canvasRef} className="share-canvas" role="img" aria-label={t("share.preview")} width={1080} height={1440} />
        </div>

        <div className="share-side">
          <div className="share-group">
            <span className="share-label">{t("share.template")}</span>
            <div className="share-thumbs" role="radiogroup" aria-label={t("share.template")}>
              {templates.map(({ id, label }) => {
                const disabled = id === "vertical" && !verticalAllowed;
                const palette = shareCardPalette(id, draft.accent, coverTone ?? FALLBACK_COVER_TONE);
                return (
                  <button key={id} type="button" role="radio" aria-checked={activeTemplate === id} disabled={disabled}
                    className="share-thumb" title={!disabled ? label : canUseVertical(passage) ? t("share.template.verticalNotLong") : t("share.template.verticalOnlyCjk")}
                    onClick={() => updateShareOptions({ template: id })}>
                    <i className={id === "vertical" ? "is-vertical" : undefined} style={{ background: palette.bg, color: palette.fg }}>
                      {id === "vertical" ? "文字" : "文"}
                    </i>
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="share-group is-ratio">
            <span className="share-label">{t("share.ratio")}</span>
            <Segmented label={t("share.ratio")} value={options.ratio} variant="compact"
              options={[
                { value: "3:4", label: t("share.ratio.portrait") },
                { value: "1:1", label: t("share.ratio.square") },
                { value: "9:16", label: t("share.ratio.story") },
                { value: "long", label: t("share.ratio.long") },
              ]}
              onChange={(ratio) => updateShareOptions({ ratio })} />
          </div>

          <div className="share-group">
            <span className="share-label">{t("share.content")}</span>
            <div className="share-toggles">
              {toggles.map(({ key, label, disabled }) => (
                <button key={key} type="button" className="share-toggle" aria-pressed={!disabled && options[key]} disabled={disabled}
                  onClick={() => updateShareOptions({ [key]: !options[key] })}>
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                    <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {sentences.length > 1 && !long && (
            <div className="share-group">
              <span className="share-label">{t("share.range")}</span>
              <div className="share-range">
                <button type="button" className="ui-quiet-btn" title={t("share.range.lessTip")} disabled={kept <= 1}
                  onClick={() => setKept((n) => Math.max(1, n - 1))}>{t("share.range.less")}</button>
                <button type="button" className="ui-quiet-btn" title={t("share.range.moreTip")} disabled={kept >= sentences.length}
                  onClick={() => setKept((n) => Math.min(sentences.length, n + 1))}>{t("share.range.more")}</button>
                <span>{t("share.range.count", { kept: shown, total: sentences.length, chars: [...quote].length })}</span>
              </div>
            </div>
          )}
          {(!long || truncated) && (
            <p className={`share-fit${truncated ? " is-truncated" : ""}`}>
              {long ? t("share.fit.longTruncated") : truncated ? t("share.fit.truncated") : t("share.fit.auto")}
              {truncated && !long && (
                <button type="button" className="share-fit-long" onClick={() => updateShareOptions({ ratio: "long" })}>
                  {t("share.fit.useLong")}
                </button>
              )}
            </p>
          )}
        </div>

        <div className="share-actions" style={{ "--share-action-count": actions.length } as CSSProperties}>
          {actions.map((action, index) => (
            <button key={action} type="button" disabled={busy}
              className={`share-action${index === actions.length - 1 ? " is-primary" : ""}`}
              onClick={() => void run(action)}>
              {actionLabel[action]}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
