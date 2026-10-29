import { isBuiltinTheme, isDarkReaderTheme, resolveReaderPalette } from "../config/readerPalette";
import {
  applyDarkThemeContrast,
  revertDarkThemeContrast,
  type DarkThemeContrastRecord,
  type DarkThemeStyleAdapter,
} from "./darkThemeContrast";
import { VIEWER_ID } from "./sanitize";
import { isCustomThemeKey } from "../config/customThemes";
import type { ReaderSettings, Theme } from "./settings";

export type ReaderThemeKind = Theme;

export const READER_THEMES: readonly ReaderThemeKind[] = ["light", "dark", "sepia", "gray"] as const;

export function isReaderTheme(value: unknown): value is ReaderThemeKind {
  return isBuiltinTheme(value) || isCustomThemeKey(value);
}

/**
 * 提取纯主题颜色与相关绘制规则的 CSS。
 *
 * 严格保留既有选择器、重要性及规则顺序；不混入字体、字号、排版或 writing-mode。
 * 背景只写 background-color longhand，不用 background 简写（防止重置作者背景图）。
 * 作者安全 bgcolor 仅在 light 主题作为默认值合入；用户 CSS 仍在本表之后。
 */
export function buildThemeCss(theme: ReaderThemeKind, authorBgColor?: string | null): string {
  const palette = resolveReaderPalette(theme);
  const {
    background: bg,
    foreground: fg,
    noteUnderline,
    searchBackground,
    searchForeground,
    tocLink,
  } = palette;
  const effectiveBg = theme === "light" && authorBgColor ? authorBgColor : bg;

  const darkRules =
    isDarkReaderTheme(theme)
      ? `/* [L2] 深色主题下着重号（text-emphasis）随前景色换色；
   书常写 text-emphasis:circle #000，深色背景上看不见。 */
#${VIEWER_ID} * { -webkit-text-emphasis-color: ${fg}; text-emphasis-color: ${fg}; }
/* [L2/C-45] 深色主题可读性兜底：让未自行声明 text-shadow 的文字
   继承与阅读器背景一致的阴影；作者后代的明确声明（包括 none）可覆盖。 */
#${VIEWER_ID} { text-shadow: 1px 1px 1px ${bg}; }
/* [L2] 深色主题目录链接换色：书常写 .toc a{color:#000}。
   与 Sigil 深色预览一致的浅蓝。 */
#${VIEWER_ID} .toc a { color: ${tocLink ?? resolveReaderPalette("dark").tocLink}; }
/* [L2] 深色主题下清除图片投影，避免在深色背景上形成白色光晕 */
#${VIEWER_ID} img { box-shadow: none !important; }`
      : "";

  return `/* [L2] 主题只覆盖背景色，不用 background 简写（会重置书的 body 背景图）。
   浅色主题下安全的书籍 bgcolor 作为默认值合入这里，用户 CSS 仍在本样式末尾。 */
body { color: ${fg}; background-color: ${effectiveBg}; }
/* [L2] 笔记标记：CSS Custom Highlight 只绘制下划线，不包裹正文节点，
   因此不会改变文字几何尺寸、分页或作者选择器匹配。颜色按 iframe 主题固定，
   不依赖宿主页面变量；不设置背景，避免遮挡原书文字。 */
::highlight(reader-notes) {
  text-decoration-line: underline;
  text-decoration-style: solid;
  text-decoration-thickness: 2px;
  text-underline-offset: 0.15em;
  text-decoration-color: ${noteUnderline};
}
/* [L2] 搜索正文命中：只使用 CSS Custom Highlight 支持的绘制属性；
   背景色保证作者白字/彩字可读，笔记下划线仍可与搜索背景共存。 */
::highlight(reader-search-hit) {
  background-color: ${searchBackground};
  color: ${searchForeground};
}
/* [L2] ruby 注音 rt 随主题换色（书常固定 ruby>rt{color:#333}）。 */
#${VIEWER_ID} rt { color: ${fg}; }
${darkRules}`.trim();
}

/** Dark-paper repairs aim at the theme's own text color; a user theme is repaired like "dark". */
function darkContrastTheme(theme: ReaderThemeKind): { theme: "dark" | "gray"; foreground?: string } {
  if (theme === "gray") return { theme: "gray" };
  return isBuiltinTheme(theme) ? { theme: "dark" } : { theme: "dark", foreground: resolveReaderPalette(theme).foreground };
}

/**
 * 从文档中发现作者保留的安全 bgcolor（由 sanitize 提取并在 body 标记）。
 */
export function getAuthorSafeBackgroundColor(doc: Document): string | null {
  const body = doc.body;
  if (!body) return null;
  const marked = body.getAttribute("data-reader-author-bgcolor")?.trim();
  if (marked) return marked;
  const raw = body.getAttribute("bgcolor")?.trim();
  return raw || null;
}

/**
 * 定位或在正确层叠位置创建 <style data-reader="theme"> 节点。
 * 位置必须在 overrides 之后、user-css 之前，保证用户自定义 CSS 拥有更高优先级。
 */
export function findOrCreateThemeStyleElement(doc: Document): HTMLStyleElement {
  const existing = doc.querySelector<HTMLStyleElement>('style[data-reader="theme"]');
  if (existing) return existing;

  const styleEl = doc.createElement("style");
  styleEl.setAttribute("data-reader", "theme");

  const head = doc.head ?? doc.documentElement;
  const userCss = doc.querySelector('style[data-reader="user-css"]');
  if (userCss && userCss.parentNode) {
    userCss.parentNode.insertBefore(styleEl, userCss);
    return styleEl;
  }

  const overrides = doc.querySelector('style[data-reader="overrides"]');
  if (overrides && overrides.parentNode) {
    overrides.parentNode.insertBefore(styleEl, overrides.nextSibling);
    return styleEl;
  }

  head.appendChild(styleEl);
  return styleEl;
}

export interface ReaderThemeOptions {
  doc: Document;
  theme: ReaderThemeKind;
  authorBgColor?: string | null;
  userOwnsColor?: (element: Element) => boolean;
  adapter?: DarkThemeStyleAdapter;
}

export interface ReaderThemeController {
  readonly currentTheme: ReaderThemeKind;
  readonly authorBgColor: string | null;
  update(theme: ReaderThemeKind): void;
  dispose(): void;
}

interface DocThemeState {
  ownerId: number;
  currentTheme: ReaderThemeKind;
  contrastRecords: DarkThemeContrastRecord[];
  authorBgColor: string | null;
  styleEl: HTMLStyleElement | null;
}

/**
 * 记录活跃文档的当前状态与 ownerId，保证：
 * 1. 每份 doc 只有一个活跃 owner，旧 owner 无法撤销新 owner 样式；
 * 2. 新 owner 接管同一文档时，继承旧修补记录与基线状态，切回浅色时能精准还原；
 * 3. 同主题重复接管不重复触发 DOM 扫描。
 */
const activeDocStates = new WeakMap<Document, DocThemeState>();
let nextOwnerId = 0;

/**
 * 扫描文档中 data-reader="user-css" 样式表，判断指定元素是否有用户定义的显式 color 规则。
 * 供未显式传入 userOwnsColor 的环境作为兜底所有权判定。
 */
export function createUserOwnsColorFilter(doc: Document): (element: Element) => boolean {
  const styles = Array.from(doc.getElementsByTagName?.("style") ?? []);
  const userStyle = styles.find(
    (style) => style.getAttribute("data-reader") === "user-css"
  ) as HTMLStyleElement | undefined;
  const sheet = userStyle?.sheet;
  if (!sheet) return () => false;

  let rules: CSSRuleList;
  try {
    rules = sheet.cssRules;
  } catch {
    return () => true;
  }

  const colorSelectors: string[] = [];
  const walk = (list: CSSRuleList): void => {
    for (const rule of Array.from(list)) {
      if ((rule as any).type === 1 /* CSSRule.STYLE_RULE */) {
        const styleRule = rule as CSSStyleRule;
        if (styleRule.style && styleRule.style.getPropertyValue("color").trim() !== "") {
          colorSelectors.push(styleRule.selectorText);
        }
      }
      const nested = rule as CSSRule & { cssRules?: CSSRuleList };
      try {
        if (nested.cssRules) walk(nested.cssRules);
      } catch {}
    }
  };
  try {
    walk(rules);
  } catch {
    return () => true;
  }

  if (colorSelectors.length === 0) return () => false;

  const cache = new WeakMap<Element, boolean>();
  return (element: Element): boolean => {
    const cached = cache.get(element);
    if (cached !== undefined) return cached;
    let owns = false;
    for (const selector of colorSelectors) {
      if (!selector) continue;
      try {
        if (element.matches(selector)) {
          owns = true;
          break;
        }
      } catch {
        owns = true;
        break;
      }
    }
    cache.set(element, owns);
    return owns;
  };
}

/**
 * 创建轻量主题原位更新控制器：
 * - 拥有 doc 的主题样式与深色对比度修补所有权；
 * - 接管已存在控制器的文档时，平滑继承其对比度记录与基线；
 * - update(theme) 同步应用新主题：先撤销旧修补再依据新主题处理，避免已修颜色被当成作者颜色；
 * - dispose() 仅撤销自己持有的改动，释放所有引用，销毁后不持有已卸载节点；
 * - 同主题重复 update 幂等；旧 owner 不撤销新 owner 样式。
 */
export function createReaderTheme(options: ReaderThemeOptions): ReaderThemeController {
  let doc: Document | null = options.doc;
  const adapter = options.adapter;
  const userOwnsColor =
    options.userOwnsColor ?? (doc ? createUserOwnsColorFilter(doc) : () => false);

  const existingState = doc ? activeDocStates.get(doc) : undefined;
  const authorBgColor =
    options.authorBgColor !== undefined
      ? options.authorBgColor
      : existingState?.authorBgColor ?? (doc ? getAuthorSafeBackgroundColor(doc) : null);

  const ownerId = ++nextOwnerId;
  let currentTheme: ReaderThemeKind = options.theme;
  let contrastRecords: DarkThemeContrastRecord[] = existingState ? existingState.contrastRecords : [];
  let disposed = false;

  let styleEl: HTMLStyleElement | null =
    existingState?.styleEl && existingState.styleEl.isConnected
      ? existingState.styleEl
      : doc
        ? findOrCreateThemeStyleElement(doc)
        : null;

  if (doc) {
    if (existingState && existingState.currentTheme === currentTheme) {
      // 主题一致：沿用已有样式和修补，无需重复扫描或改写
      activeDocStates.set(doc, {
        ownerId,
        currentTheme,
        contrastRecords,
        authorBgColor,
        styleEl,
      });
    } else {
      // 全新创建或接管并切换主题
      if (contrastRecords.length > 0) {
        revertDarkThemeContrast(contrastRecords, adapter);
        contrastRecords = [];
      }
      if (styleEl) {
        styleEl.textContent = buildThemeCss(currentTheme, authorBgColor);
      }
      if (isDarkReaderTheme(currentTheme)) {
        applyDarkThemeContrast(doc, {
          ...darkContrastTheme(currentTheme),
          adapter,
          userOwnsColor,
          records: contrastRecords,
        });
      }
      activeDocStates.set(doc, {
        ownerId,
        currentTheme,
        contrastRecords,
        authorBgColor,
        styleEl,
      });
    }
  }

  return {
    get currentTheme() {
      return currentTheme;
    },
    get authorBgColor() {
      return authorBgColor;
    },
    update(theme: ReaderThemeKind) {
      if (disposed || !doc) return;
      const state = activeDocStates.get(doc);
      if (!state || state.ownerId !== ownerId) return;
      if (theme === currentTheme) return;

      // 1. 先撤销旧修补，保证 DOM 恢复作者原色
      if (contrastRecords.length > 0) {
        revertDarkThemeContrast(contrastRecords, adapter);
        contrastRecords = [];
      }

      // 2. 原位更新纯主题 CSS
      if (!styleEl || !styleEl.isConnected) {
        styleEl = findOrCreateThemeStyleElement(doc);
      }
      styleEl.textContent = buildThemeCss(theme, authorBgColor);

      // 3. 进入深色/灰色时应用新修补
      if (isDarkReaderTheme(theme)) {
        applyDarkThemeContrast(doc, {
          ...darkContrastTheme(theme),
          adapter,
          userOwnsColor,
          records: contrastRecords,
        });
      }

      currentTheme = theme;
      state.currentTheme = theme;
      state.contrastRecords = contrastRecords;
      state.styleEl = styleEl;
    },
    dispose() {
      if (disposed) return;
      disposed = true;

      if (doc) {
        const state = activeDocStates.get(doc);
        if (state && state.ownerId === ownerId) {
          activeDocStates.delete(doc);

          if (contrastRecords.length > 0) {
            revertDarkThemeContrast(contrastRecords, adapter);
            contrastRecords = [];
          }

          if (styleEl && styleEl.parentNode) {
            styleEl.parentNode.removeChild(styleEl);
          }
        }
      }

      contrastRecords = [];
      styleEl = null;
      doc = null;
    },
  };
}

export function samePageMargins(
  a: ReaderSettings["pageMarginsPx"],
  b: ReaderSettings["pageMarginsPx"],
): boolean {
  if (a === b) return true;
  const keys = ["top", "bottom", "left", "right"] as const;
  for (const key of keys) {
    if ((a?.[key] ?? null) !== (b?.[key] ?? null)) return false;
  }
  return true;
}

/**
 * 比较两份阅读设置中影响几何排版/分栏/字号/字体的属性（不含纯主题颜色与预加载等纯调度属性）。
 */
export function sameLayoutSettings(a: ReaderSettings, b: ReaderSettings): boolean {
  return (
    a.fontSizePx === b.fontSizePx &&
    a.fontFamily === b.fontFamily &&
    a.customFontName === b.customFontName &&
    a.fontSource === b.fontSource &&
    a.customFontId === b.customFontId &&
    (a.forceFontOverride === true) === (b.forceFontOverride === true) &&
    a.customFonts === b.customFonts &&
    a.customCss === b.customCss &&
    a.gapPx === b.gapPx &&
    a.readingMode === b.readingMode &&
    a.columnsPerView === b.columnsPerView &&
    a.spreadGapMode === b.spreadGapMode &&
    samePageMargins(a.pageMarginsPx, b.pageMarginsPx) &&
    a.lineHeight === b.lineHeight &&
    a.fontWeight === b.fontWeight &&
    a.letterSpacingPx === b.letterSpacingPx &&
    a.wordSpacingPx === b.wordSpacingPx &&
    a.forceHorizontal === b.forceHorizontal &&
    (a.pageDirection ?? "book") === (b.pageDirection ?? "book")
  );
}

/**
 * 比较两份阅读设置是否对当前渲染完全一致（含主题颜色）。
 */
export function sameRenderingSettings(a: ReaderSettings, b: ReaderSettings): boolean {
  return a.theme === b.theme && sameLayoutSettings(a, b);
}

export type SettingsChangeClassification = "none" | "theme-only" | "layout";

/**
 * 对设置变更进行分层分类：
 * - "none": 无渲染相关变更
 * - "theme-only": 纯主题颜色变更，无需重排/测页/重载
 * - "layout": 涉及字号/字体/分栏/排版等几何属性，必须走重排/重载
 */
export function classifySettingsChange(
  previous: ReaderSettings,
  current: ReaderSettings,
  previousUserFonts?: unknown,
  currentUserFonts?: unknown,
): SettingsChangeClassification {
  if (sameRenderingSettings(previous, current) && previousUserFonts === currentUserFonts) {
    return "none";
  }
  if (sameLayoutSettings(previous, current) && previousUserFonts === currentUserFonts) {
    return "theme-only";
  }
  return "layout";
}
