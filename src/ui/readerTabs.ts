/**
 * A11：阅读器标签页模型。
 *
 * 只记录“哪些书开着、哪本在前面”，不保存阅读位置；位置照常走现有进度存储，
 * 不新增第二份位置真相。按“栏”组织，V1 只有一栏；A14 并排阅读会在同一模型上
 * 加第二栏。纯函数，不碰 DOM 和存储之外的状态。
 */

export const READER_TABS_STORAGE_KEY = "epub-reader:reader-tabs:v1";
/** 同时开着的书最多几本：顶栏中间还要放进度胶囊。 */
export const MAX_READER_TABS = 5;

export interface ReaderTabGroup {
  /** 书架条目 ID，按标签从左到右排列，不重复。 */
  readonly tabs: readonly string[];
  readonly active: string | null;
}

export interface ReaderTabsState {
  readonly groups: readonly ReaderTabGroup[];
  readonly activeGroup: number;
}

export const EMPTY_READER_TABS: ReaderTabsState = { groups: [{ tabs: [], active: null }], activeGroup: 0 };

function currentGroup(state: ReaderTabsState): ReaderTabGroup {
  return state.groups[state.activeGroup] ?? { tabs: [], active: null };
}

function withGroup(state: ReaderTabsState, group: ReaderTabGroup): ReaderTabsState {
  const groups = state.groups.slice();
  groups[state.activeGroup] = group;
  return { ...state, groups };
}

/** 已开着就切过去；没开就插在当前标签右侧并切过去。 */
export function openReaderTab(state: ReaderTabsState, id: string): ReaderTabsState {
  const group = currentGroup(state);
  if (group.tabs.includes(id)) return group.active === id ? state : withGroup(state, { ...group, active: id });
  const at = group.active === null ? group.tabs.length : group.tabs.indexOf(group.active) + 1;
  const tabs = [...group.tabs.slice(0, at), id, ...group.tabs.slice(at)];
  return withGroup(state, { tabs, active: id });
}

/**
 * 一本书进入阅读器时放在哪：已开着就切过去；“新标签”插在当前右侧（满了就替换当前）；
 * 普通打开替换当前这本，和浏览器点普通链接一样。
 */
export function placeReaderTab(state: ReaderTabsState, id: string, mode: "replace" | "new"): ReaderTabsState {
  const group = currentGroup(state);
  if (group.tabs.includes(id) || group.active === null) return openReaderTab(state, id);
  if (mode === "new" && group.tabs.length < MAX_READER_TABS) return openReaderTab(state, id);
  return withGroup(state, { tabs: group.tabs.map((tab) => (tab === group.active ? id : tab)), active: id });
}

/** 关闭后应切到的书：关当前标签时先右后左；关别的标签不切换；最后一个关掉返回 null。 */
export function closeReaderTab(state: ReaderTabsState, id: string): { state: ReaderTabsState; next: string | null } {
  const group = currentGroup(state);
  const index = group.tabs.indexOf(id);
  if (index < 0) return { state, next: group.active };
  const tabs = group.tabs.filter((tab) => tab !== id);
  const active = group.active === id ? (tabs[index] ?? tabs[index - 1] ?? null) : group.active;
  return { state: withGroup(state, { tabs, active }), next: active };
}

/** Closing the book on screen must not remove its tab until leaving has succeeded. */
export async function closeReaderTabAfterLeave(
  state: ReaderTabsState,
  id: string,
  leave: () => Promise<boolean>,
  commit: (result: ReturnType<typeof closeReaderTab>) => void,
): Promise<void> {
  if (await leave()) commit(closeReaderTab(state, id));
}

/** 相对当前标签循环移动（Ctrl+Tab / Ctrl+Shift+Tab）。 */
export function cycleReaderTab(state: ReaderTabsState, step: 1 | -1): string | null {
  const group = currentGroup(state);
  if (group.tabs.length === 0) return null;
  const index = group.active === null ? -1 : group.tabs.indexOf(group.active);
  return group.tabs[(index + step + group.tabs.length) % group.tabs.length];
}

/** 去掉已经不在书架上的书（删除、导入失败等），保持其余顺序。 */
export function pruneReaderTabs(state: ReaderTabsState, exists: (id: string) => boolean): ReaderTabsState {
  let changed = false;
  const groups = state.groups.map((group) => {
    const tabs = group.tabs.filter(exists);
    if (tabs.length === group.tabs.length) return group;
    changed = true;
    const active = group.active !== null && tabs.includes(group.active) ? group.active : (tabs[0] ?? null);
    return { tabs, active };
  });
  return changed ? { ...state, groups } : state;
}

export function serializeReaderTabs(state: ReaderTabsState): string {
  return JSON.stringify({ v: 1, groups: state.groups, activeGroup: state.activeGroup });
}

/** 读不懂的内容一律当作没有标签；高版本写出的多栏数据只取能读的部分。 */
export function parseReaderTabs(raw: string | null | undefined): ReaderTabsState {
  if (!raw) return EMPTY_READER_TABS;
  try {
    const value = JSON.parse(raw) as { groups?: unknown; activeGroup?: unknown };
    if (!Array.isArray(value.groups) || value.groups.length === 0) return EMPTY_READER_TABS;
    const groups: ReaderTabGroup[] = value.groups.map((group) => {
      const record = (group ?? {}) as { tabs?: unknown; active?: unknown };
      const tabs = Array.isArray(record.tabs)
        ? [...new Set(record.tabs.filter((tab): tab is string => typeof tab === "string" && tab !== ""))]
        : [];
      const active = typeof record.active === "string" && tabs.includes(record.active) ? record.active : (tabs[0] ?? null);
      return { tabs: keepAround(tabs, active), active };
    });
    const activeGroup = typeof value.activeGroup === "number" && Number.isInteger(value.activeGroup)
      && value.activeGroup >= 0 && value.activeGroup < groups.length ? value.activeGroup : 0;
    return { groups, activeGroup };
  } catch {
    return EMPTY_READER_TABS;
  }
}

/** 超过上限的旧数据：保留当前这本和它最近的几本。 */
function keepAround(tabs: string[], active: string | null): string[] {
  if (tabs.length <= MAX_READER_TABS) return tabs;
  const at = Math.max(0, active === null ? 0 : tabs.indexOf(active));
  const start = Math.min(Math.max(0, at - Math.floor(MAX_READER_TABS / 2)), tabs.length - MAX_READER_TABS);
  return tabs.slice(start, start + MAX_READER_TABS);
}

export function activeReaderTabs(state: ReaderTabsState): ReaderTabGroup {
  return currentGroup(state);
}

const TITLE_PREFIX = /^(?:【[^】]*】|\[[^\]]*\])\s*[.·・]?\s*/u;
const TITLE_VOLUME = /[\s.·・_-]*(第?\d+[卷巻册冊部话話]?|[(（]\d+[)）]|[上中下]|[IVX]+)$/u;

/** 去掉开头的方括号前缀（【…】、[…]），并把末尾卷号单独拿出来。 */
export function splitTabTitle(title: string): { head: string; tail: string } {
  let text = title.trim();
  for (;;) {
    const stripped = text.replace(TITLE_PREFIX, "");
    if (stripped === text || stripped === "") break;
    text = stripped;
  }
  const match = TITLE_VOLUME.exec(text);
  if (!match || match.index === 0 || [...match[1]].length > 6) return { head: text, tail: "" };
  return { head: text.slice(0, match.index), tail: match[1] };
}

/**
 * 按字数缩短的书名（中间省略，保留卷号），用在放不下整本书名的按钮文字里。
 * 顶栏标签按实际宽度由 CSS 省略书名主体，卷号单独显示（splitTabTitle）。
 */
export function shortTabTitle(title: string, max = 14): string {
  const { head, tail } = splitTabTitle(title);
  const text = tail ? `${head} ${tail}` : head;
  if ([...text].length <= max) return text;
  const base = [...head];
  const room = Math.max(2, max - 1 - (tail ? [...tail].length + 1 : 0));
  const first = Math.ceil(room * 0.6);
  const end = base.slice(base.length - (room - first)).join("");
  return `${base.slice(0, first).join("")}…${end}${tail ? ` ${tail}` : ""}`;
}

/** 顶栏标签的宽度：每个 96–160px，当前这本至少 128px。 */
export const TAB_MIN_PX = 96;
export const TAB_ACTIVE_MIN_PX = 128;
export const TAB_MAX_PX = 160;

/**
 * 放得下几个标签：放不下时从离当前最远的开始收进“+N”列表，当前这本一直露在外面。
 * `budget` 是标签条可用宽度（含“＋”和“+N”）；不知道宽度（0）时全部显示。
 */
export function fitReaderTabs(
  tabs: readonly string[],
  active: string | null,
  budget: number,
  extras: { plus: number; more: number; gap: number },
): { visible: string[]; hidden: string[] } {
  const all = [...tabs];
  if (budget <= 0 || all.length === 0) return { visible: all, hidden: [] };
  const need = (count: number, withMore: boolean) =>
    TAB_ACTIVE_MIN_PX + Math.max(0, count - 1) * TAB_MIN_PX + extras.plus + (withMore ? extras.more : 0) + (count + (withMore ? 1 : 0)) * extras.gap;
  if (need(all.length, false) <= budget) return { visible: all, hidden: [] };
  let count = all.length - 1;
  while (count > 1 && need(count, true) > budget) count--;
  const at = Math.max(0, active === null ? 0 : all.indexOf(active));
  const byDistance = all
    .map((id, index) => ({ id, index, distance: Math.abs(index - at) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index);
  const keep = new Set(byDistance.slice(0, Math.max(1, count)).map((item) => item.id));
  return { visible: all.filter((id) => keep.has(id)), hidden: all.filter((id) => !keep.has(id)) };
}
