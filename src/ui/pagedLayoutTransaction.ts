import type { ReaderSettings } from "../render/settings";
import { sameLayoutSettings, sameRenderingSettings } from "../render/readerTheme";

export interface PagedLayoutSlotTarget {
  paginator: {
    reloadWithSettingsAndWaitForDisplay(settings: ReaderSettings, anchor?: string): Promise<boolean>;
    updateTheme(theme: ReaderSettings["theme"]): boolean;
  } | null;
  path: string | null;
  spineIndex: number | null;
  generation: number;
  renderSettings: ReaderSettings;
}

export interface RunLayoutReloadOptions {
  epoch: number;
  slot: PagedLayoutSlotTarget;
  isCurrent: () => boolean;
  getDesiredSettings: () => ReaderSettings;
  onCommitLayout?: (settings: ReaderSettings) => void;
  onSyncTheme?: (theme: ReaderSettings["theme"]) => void;
}

/**
 * 分页视图排版重排事务协调器。
 *
 * 核心保证：
 * 1. 事务持有自身代次、目标槽位及章节身份，新布局请求、换章导航、槽位释放使旧事务立即失效；
 * 2. 只有本次事务在 paginator 内部对应代次的 display-ready 成功后才提交实际 layout 设置；
 * 3. 失败、取消和过期只退出，绝不将旧代次设置（如慢请求 24 晚于新请求 26 完成）回写进新 slot；
 * 4. 纯主题变更不递增几何代次、不取消已欠的布局请求；重排完成后若发现期间发生了纯主题变更，原位同步最新主题，无需进行第二次布局重排。
 */
export class PagedLayoutTransactionCoordinator {
  private currentEpoch = 0;

  get epoch(): number {
    return this.currentEpoch;
  }

  /**
   * 发起一次新的几何排版重排请求，递增代次并使之前的所有重载事务失效。
   */
  requestLayoutReload(): number {
    return ++this.currentEpoch;
  }

  /**
   * 导航、切章、卸载或销毁时使当前所有重载事务失效。
   */
  invalidate(): void {
    this.currentEpoch++;
  }

  /**
   * 执行一次受代次与槽位身份保护的排版重载事务。
   */
  async runTransaction(options: RunLayoutReloadOptions): Promise<boolean> {
    const { epoch, slot, isCurrent, getDesiredSettings, onCommitLayout, onSyncTheme } = options;

    if (!isCurrent() || this.currentEpoch !== epoch) return false;
    const paginator = slot.paginator;
    if (!paginator) return false;

    do {
      if (!isCurrent() || this.currentEpoch !== epoch) return false;
      const target = getDesiredSettings();

      // 若设置已完全一致，无需重载
      if (sameRenderingSettings(slot.renderSettings, target)) return true;

      // 若几何已一致，仅差主题，直接原位更新
      if (sameLayoutSettings(slot.renderSettings, target)) {
        if (paginator.updateTheme(target.theme)) {
          slot.renderSettings = { ...slot.renderSettings, theme: target.theme };
          onSyncTheme?.(target.theme);
        }
        return true;
      }

      // 等待本次事务在 paginator 内部对应代次的最终 display-ready
      const ready = await paginator.reloadWithSettingsAndWaitForDisplay(target);

      // 关键代次与身份检查：
      // - 代次是否已被新请求废弃（如旧 24 晚于新 26 完成）
      // - 槽位/章节是否被导航或切章替换
      // - 本次重排是否成功完成 display-ready
      if (!isCurrent() || this.currentEpoch !== epoch) return false;
      if (!ready) return false;

      // 真正完成排版且代次有效，才提交实际 layout 设置
      slot.renderSettings = { ...target };
      onCommitLayout?.(target);

      // 检查进行中是否发生了纯主题变更：仅差主题就原位协调，无需触发第二次整章重载
      const latest = getDesiredSettings();
      if (sameRenderingSettings(slot.renderSettings, latest)) {
        return true;
      }
      if (sameLayoutSettings(slot.renderSettings, latest)) {
        if (paginator.updateTheme(latest.theme)) {
          slot.renderSettings = { ...slot.renderSettings, theme: latest.theme };
          onSyncTheme?.(latest.theme);
        }
        return true;
      }
    } while (isCurrent() && this.currentEpoch === epoch && !sameRenderingSettings(slot.renderSettings, getDesiredSettings()));

    return isCurrent() && this.currentEpoch === epoch;
  }
}
