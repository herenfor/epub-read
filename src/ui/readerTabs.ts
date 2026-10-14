/**
 * A11 V1：阅读器标签页模型（只在 Dev/调试构建启用）。
 *
 * 只记录“哪些书开着、哪本在前面”，不保存阅读位置；位置照常走现有进度存储，
 * 不新增第二份位置真相。按“栏”组织，V1 只有一栏；A14 并排阅读会在同一模型上
 * 加第二栏。纯函数，不碰 DOM 和存储之外的状态。
 */

export const READER_TABS_STORAGE_KEY = "epub-reader:reader-tabs:v1";

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

/** 关闭后应切到的书：关当前标签时先右后左；关别的标签不切换；最后一个关掉返回 null。 */
export function closeReaderTab(state: ReaderTabsState, id: string): { state: ReaderTabsState; next: string | null } {
  const group = currentGroup(state);
  const index = group.tabs.indexOf(id);
  if (index < 0) return { state, next: group.active };
  const tabs = group.tabs.filter((tab) => tab !== id);
  const active = group.active === id ? (tabs[index] ?? tabs[index - 1] ?? null) : group.active;
  return { state: withGroup(state, { tabs, active }), next: active };
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
      return { tabs, active };
    });
    const activeGroup = typeof value.activeGroup === "number" && Number.isInteger(value.activeGroup)
      && value.activeGroup >= 0 && value.activeGroup < groups.length ? value.activeGroup : 0;
    return { groups, activeGroup };
  } catch {
    return EMPTY_READER_TABS;
  }
}

export function activeReaderTabs(state: ReaderTabsState): ReaderTabGroup {
  return currentGroup(state);
}
