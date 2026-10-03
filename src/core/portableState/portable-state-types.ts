/** Frozen design DTOs; these modules are not yet wired into the application. */
import type { LibraryOrganization, Register } from "../../ui/libraryOrganization";
import type { Theme } from "../../render/settings";
import type { Annotation, Version } from "./portable-register-core";

export type ModernLocator = {
  readonly locatorVersion: 1;
  readonly chapterPath: string;
  readonly spineIndexHint: number;
  readonly target:
    | { readonly kind: "chapter-start" }
    | { readonly kind: "text"; readonly textProfile: "visible-codepoints-no-whitespace-v1";
        readonly offset: number; readonly snippet: string }
    | { readonly kind: "media"; readonly signature: string; readonly indexHint: number;
        readonly tag: "img" | "svg" | "video"; readonly ratio: number };
};

export type LegacyLocator = {
  readonly locatorVersion: 0;
  readonly spineIndex: number;
  readonly pageHint: number;
  readonly anchorIndex: number | null;
  readonly anchorRatio: number | null;
  readonly anchorTextOffset: number | null;
  readonly anchorTextSnippet: string | null;
  readonly mediaAnchor: { readonly index: number; readonly tag: string;
    readonly signature: string; readonly ratio: number } | null;
};

export type Locator = ModernLocator | LegacyLocator;
export type ProgressValue = { readonly locator: Locator; readonly progressPctHint: number } | null;
export type BookmarkValue = { readonly locator: Locator; readonly text: string; readonly createdAtMs: number };
export type NoteValue = {
  readonly chapterPath: string;
  readonly spineIndexHint: number;
  readonly textProfile: "visible-codepoints-no-whitespace-v1";
  readonly startTextOffset: number;
  readonly endTextOffset: number;
  readonly startTextSnippet: string;
  readonly endTextSnippet: string;
  readonly selectedText: string;
  readonly content: string;
  readonly createdAtMs: number;
};
export type BookMetadata = { readonly title: string; readonly creator: string;
  readonly language?: string; readonly fileName: string; readonly addedAtMs: number };
export type PortableBook = {
  readonly metadata: Register<BookMetadata>;
  readonly progress: { readonly versions: readonly Version<ProgressValue>[] };
  readonly bookmarks: Readonly<Record<string, Annotation<BookmarkValue>>>;
  readonly notes: Readonly<Record<string, Annotation<NoteValue>>>;
};
export type PortablePreferences = { readonly theme?: Theme; readonly fontSizePx?: number;
  readonly lineHeight?: number; readonly fontWeight?: number;
  readonly letterSpacingPx?: number; readonly wordSpacingPx?: number };
export type PortableStateV3 = {
  readonly schemaVersion: 3;
  readonly books: Readonly<Record<string, PortableBook>>;
  readonly organization: LibraryOrganization;
  readonly preferences?: PortablePreferences;
};
