export type ReleaseNoteCategory = "new" | "improved" | "fixed";
export type ReleaseNoteStatus = "released" | "development";

export type ReleaseNoteItem = Readonly<{
  category: ReleaseNoteCategory;
  text: string;
}>;

export type ReleaseNote = Readonly<{
  version: string;
  status: ReleaseNoteStatus;
  /** Real public release date only; omitted for unreleased development versions. */
  releasedOn?: string;
  items: readonly ReleaseNoteItem[];
}>;

export const RELEASE_CATEGORY_LABELS: Readonly<Record<ReleaseNoteCategory, string>> = {
  new: "新增",
  improved: "改进",
  fixed: "修复",
};

export const RELEASE_STATUS_LABELS: Readonly<Record<ReleaseNoteStatus, string>> = {
  released: "已发布",
  development: "开发中",
};

/**
 * Local, user-facing release notes. Keep this small: add the version actually
 * installed by the app and only record features that are merged for that line.
 * Do not invent release dates or promise that a development build contains
 * every feature that is still being worked on.
 */
export const RELEASE_NOTES: readonly ReleaseNote[] = [
  {
    version: "0.2.8",
    status: "development",
    items: [
      {
        category: "new",
        text: "打开书籍、加载章节和准备排版时会显示真实的加载反馈，不再让界面看起来没有响应。",
      },
      {
        category: "new",
        text: "“关于”区显示实际安装版本、Core/AI edition 与实际平台，并支持复制版本信息。",
      },
      {
        category: "new",
        text: "“关于”区新增版本说明，可查看当前版本状态和折叠的历史版本说明。",
      },
      {
        category: "improved",
        text: "版本来源改为原生握手信息或 Web 构建版本，不能用源码版本冒充当前安装包。",
      },
      {
        category: "improved",
        text: "书架设置和手机阅读“更多”层共用同一套关于信息，避免两个入口显示不一致。",
      },
    ],
  },
  {
    version: "0.2.7",
    status: "released",
    releasedOn: "2026-10-02",
    items: [
      {
        category: "new",
        text: "书架重新设计：支持网格/列表、文件夹、继续阅读行，并可按最近阅读、加入时间、书名或阅读进度排序。",
      },
      {
        category: "new",
        text: "最大化窗口进入全屏时不再留下任务栏高度的黑边，退出全屏后恢复原来的最大化状态。",
      },
      {
        category: "new",
        text: "双页模式阅读区域更舒适：外边距和书页间距会随窗口宽度调整。",
      },
      {
        category: "fixed",
        text: "沉浸式窗口下可从底边呼出底部阅读栏，不再必须把指针移到阅读栏上。",
      },
      {
        category: "fixed",
        text: "标题栏进度胶囊改为真正按钮，点击章节文字、轨道或百分比会打开侧栏，不会拖拽窗口。",
      },
      {
        category: "fixed",
        text: "从全屏返回书架时，第一行不再被固定标题栏挡住。",
      },
      {
        category: "fixed",
        text: "代码块中的长行会自动换行，不再跑出页面。",
      },
      {
        category: "fixed",
        text: "阅读面板中的自动值显示“自动”，不再显示一个像手动设置的数字。",
      },
      {
        category: "fixed",
        text: "导入书籍不再让整个应用卡住；可以在导入时继续阅读或整理已有书籍。",
      },
      {
        category: "fixed",
        text: "关闭阅读器时如果有未保存笔记，会先询问，不再静默丢弃。",
      },
      {
        category: "fixed",
        text: "双页模式长章节翻页更快，不再重复无意义的测量。",
      },
    ],
  },
  {
    version: "0.2.6",
    status: "released",
    releasedOn: "2026-09-29",
    items: [
      {
        category: "fixed",
        text: "修复跨页框归属判断：右侧页面上的框不再被误认为左侧内容溢出的部分。",
      },
      {
        category: "fixed",
        text: "百分比内边距和外边距改为按当前页宽度计算，单页/双页下的缩进更一致。",
      },
      {
        category: "fixed",
        text: "比文字区域宽的图片会缩小到页面内，同时保留书籍自身设置的更窄限制。",
      },
      {
        category: "fixed",
        text: "带自身内边距或边框的框不再被阅读器默认文本宽度挤压。",
      },
    ],
  },
  {
    version: "0.2.5",
    status: "released",
    releasedOn: "2026-09-28",
    items: [
      {
        category: "new",
        text: "新增双页跨页：阅读面板的布局改成单页、双页跨页、滚动三选一；窄窗口会自动回退到单页并提示原因。",
      },
      {
        category: "fixed",
        text: "超长章节改为后台准备，不再让窗口冻结数秒。",
      },
      {
        category: "fixed",
        text: "跨章节滚轮更跟手，不再需要长推一下又短暂无响应。",
      },
      {
        category: "fixed",
        text: "长章节内滚动不再缓慢上漂。",
      },
      {
        category: "fixed",
        text: "纯空白章节不再吞掉阅读状态，阅读器保持位置和响应。",
      },
      {
        category: "fixed",
        text: "双页跨页的最后一屏不再被裁切，切换字体大小或窗口宽度后仍回到同一段落。",
      },
      {
        category: "fixed",
        text: "双页书签会高亮在真正包含书签的页面上，跳转位置正确。",
      },
    ],
  },
];

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

/** Exact version match after allowing an optional leading "v". */
export function findReleaseNote(version: string): ReleaseNote | null {
  const normalized = normalizeVersion(version);
  return RELEASE_NOTES.find((note) => normalizeVersion(note.version) === normalized) ?? null;
}

/** History entries excluding the currently displayed version. */
export function listPreviousReleaseNotes(version: string): readonly ReleaseNote[] {
  const normalized = normalizeVersion(version);
  return RELEASE_NOTES.filter((note) => normalizeVersion(note.version) !== normalized);
}
