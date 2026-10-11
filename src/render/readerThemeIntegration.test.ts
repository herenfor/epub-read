import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { READER_PALETTES } from "../config/readerPalette";
import { DARK_THEME_MARKER } from "./darkThemeContrast";
import {
  classifySettingsChange,
  createReaderTheme,
  sameLayoutSettings,
  sameRenderingSettings,
} from "./readerTheme";
import { DEFAULT_SETTINGS, type ReaderSettings } from "./settings";
import { readerSurfaceBackground } from "../ui/ReaderView";
import { continuousSurfaceBackground } from "../ui/ContinuousReaderView";

describe("主题原位更新与阅读宿主集成契约", () => {
  it("纯主题切换不重排/重载，真实布局变更仍走重排", () => {
    const base: ReaderSettings = { ...DEFAULT_SETTINGS, theme: "light", fontSizePx: 18 };
    const darkTheme: ReaderSettings = { ...base, theme: "dark" };
    const sepiaTheme: ReaderSettings = { ...base, theme: "sepia" };
    const fontSizeChange: ReaderSettings = { ...base, fontSizePx: 20 };
    const mixedChange: ReaderSettings = { ...base, theme: "dark", fontSizePx: 20 };

    // 纯主题变更
    expect(sameRenderingSettings(base, darkTheme)).toBe(false);
    expect(sameLayoutSettings(base, darkTheme)).toBe(true);
    expect(classifySettingsChange(base, darkTheme)).toBe("theme-only");
    expect(classifySettingsChange(base, sepiaTheme)).toBe("theme-only");

    // 几何排版变更
    expect(sameLayoutSettings(base, fontSizeChange)).toBe(false);
    expect(classifySettingsChange(base, fontSizeChange)).toBe("layout");

    // 主题与字号同次变更 -> 必须走 layout 重排
    expect(classifySettingsChange(base, mixedChange)).toBe("layout");
  });

  it("连续快速切换以最后请求为准，往返不积累 inline 标记并保留节点身份", () => {
    const { document } = parseHTML(`
      <html style="background-color: #ffffff">
        <head><style data-reader="overrides">body{font-size:16px;}</style></head>
        <body style="background-color: #ffffff">
          <div id="content">
            <p id="p1" style="color: #111111">深度暗色正文</p>
            <p id="p2" style="color: #0000ff">作者保留蓝字</p>
          </div>
        </body>
      </html>
    `);

    const p1 = document.querySelector("#p1") as HTMLElement;
    const p2 = document.querySelector("#p2") as HTMLElement;
    const initialP1 = p1;
    const initialDoc = document;

    const controller = createReaderTheme({
      doc: document,
      theme: "light",
      authorBgColor: "#ffffff",
    });

    // 初始 light
    expect(document.querySelector('style[data-reader="theme"]')?.textContent).toContain(
      READER_PALETTES.light.foreground,
    );

    // 快速连续切换：light -> dark -> sepia -> gray
    controller.update("dark");
    expect(controller.currentTheme).toBe("dark");

    controller.update("sepia");
    expect(controller.currentTheme).toBe("sepia");

    controller.update("gray");
    expect(controller.currentTheme).toBe("gray");

    // 最终落在 gray
    expect(document.querySelector('style[data-reader="theme"]')?.textContent).toContain(
      READER_PALETTES.gray.background,
    );
    // 节点身份完全保持不变（未发生重建或 innerHTML 替换）
    expect(document.querySelector("#p1")).toBe(initialP1);
    expect(document).toBe(initialDoc);

    // 切回 light：撤销所有修补
    controller.update("light");
    expect(p1.hasAttribute(DARK_THEME_MARKER)).toBe(false);
    expect(p1.style.color).toBe("#111111"); // 原始作者字色精确恢复
    expect(p2.style.color).toBe("#0000ff"); // 彩色文字未受污染

    controller.dispose();
  });

  it("缓存章与备用槽位在提升为可见前同步最新主题", () => {
    // 模拟一个处于备用槽位的已就绪章节（在 light 下完成准备）
    const { document: spareDoc } = parseHTML(`
      <html>
        <head><style data-reader="overrides">p{margin:0}</style></head>
        <body><p id="spare-p">下一章正文</p></body>
      </html>
    `);
    const spareController = createReaderTheme({
      doc: spareDoc,
      theme: "light",
    });

    let spareRenderSettings: ReaderSettings = {
      ...DEFAULT_SETTINGS,
      theme: "light",
    };
    const latestRenderSettings: ReaderSettings = {
      ...DEFAULT_SETTINGS,
      theme: "dark",
    };

    // 用户在当前章将全局主题切换为 dark
    // 备用槽位在提升前进行原位同步
    if (sameLayoutSettings(spareRenderSettings, latestRenderSettings)) {
      if (spareRenderSettings.theme !== latestRenderSettings.theme) {
        spareController.update(latestRenderSettings.theme);
        spareRenderSettings = { ...spareRenderSettings, theme: latestRenderSettings.theme };
      }
    }

    // 备用槽位已跟上最新主题
    expect(sameRenderingSettings(spareRenderSettings, latestRenderSettings)).toBe(true);
    expect(spareDoc.querySelector('style[data-reader="theme"]')?.textContent).toContain(
      READER_PALETTES.dark.background,
    );

    spareController.dispose();
  });

  it("多所有者生命周期与过期所有者安全隔离", () => {
    const { document } = parseHTML("<html><body><p id='txt'>正文</p></body></html>");

    // 所有者 1（例如当前视图）
    const owner1 = createReaderTheme({
      doc: document,
      theme: "dark",
    });

    expect(owner1.currentTheme).toBe("dark");

    // 所有者 2（例如重挂载或宿主重绑）
    const owner2 = createReaderTheme({
      doc: document,
      theme: "dark",
    });

    // owner1 被废弃销毁
    owner1.dispose();

    // owner2 仍拥有所有权，文档样式未被 owner1 错误销毁
    expect(document.querySelector('style[data-reader="theme"]')).not.toBeNull();

    // owner2 可以正常切到 sepia
    owner2.update("sepia");
    expect(document.querySelector('style[data-reader="theme"]')?.textContent).toContain(
      READER_PALETTES.sepia.background,
    );

    // owner2 最终销毁
    owner2.dispose();
    expect(document.querySelector('style[data-reader="theme"]')).toBeNull();
  });

  it("控制器与多章节状态流转模拟契约：长正文主题往返 → 缓存章提升 → 连续同屏章 → 分页模式", () => {
    // 阶段 1：长正文文档（含作者背景图与自定义 bgcolor）
    const { document: doc1 } = parseHTML(`
      <html style="background-color: #fcfbf9">
        <head><style data-reader="overrides">body{font-size:16px;line-height:1.6;}</style></head>
        <body data-reader-author-bgcolor="#fcfbf9" style="background-image: url('pattern.png'); background-color: #fcfbf9">
          <article id="epub-viewer">
            <h1 id="title">第一章：长正文</h1>
            <p id="p-first" style="color: #1a1a1a">第一段文字内容，包含搜索高亮与笔记标记。</p>
            <p id="p-second" style="color: #222222">第二段文字内容，作者自定义轻灰字。</p>
          </article>
        </body>
      </html>
    `);

    const titleNode = doc1.querySelector("#title");
    const pFirstNode = doc1.querySelector("#p-first");
    const pSecondNode = doc1.querySelector("#p-second");

    // 加载长正文，初始为 light 主题
    const pagedController = createReaderTheme({
      doc: doc1,
      theme: "light",
      authorBgColor: "#fcfbf9",
    });

    const bodyEl = doc1.body as HTMLElement;
    // 验证初始状态：作者背景图与作者 safe bgcolor 完好
    expect(bodyEl.style.backgroundImage).toBe("url('pattern.png')");
    expect(doc1.querySelector('style[data-reader="theme"]')?.textContent).toContain("background-color: #fcfbf9");
    expect(doc1.querySelector('style[data-reader="theme"]')?.textContent).toContain("::highlight(reader-notes)");

    // 1.1 主题往返：light -> dark
    pagedController.update("dark");
    expect(pagedController.currentTheme).toBe("dark");
    // 验证：背景图未被 background 简写抹掉
    expect(bodyEl.style.backgroundImage).toBe("url('pattern.png')");
    // 验证：节点身份未重建
    expect(doc1.querySelector("#title")).toBe(titleNode);
    expect(doc1.querySelector("#p-first")).toBe(pFirstNode);

    // 1.2 主题往返：dark -> sepia -> gray -> light
    pagedController.update("sepia");
    pagedController.update("gray");
    pagedController.update("light");
    expect(pagedController.currentTheme).toBe("light");
    // 验证：浅色主题下精准还原作者 safe bgcolor，作者背景图依然完好
    expect(doc1.querySelector('style[data-reader="theme"]')?.textContent).toContain("background-color: #fcfbf9");
    expect(bodyEl.style.backgroundImage).toBe("url('pattern.png')");
    // 节点身份完全保留
    expect(doc1.querySelector("#p-second")).toBe(pSecondNode);

    // 阶段 2：切缓存章（备用槽位提升）
    const { document: doc2 } = parseHTML(`
      <html>
        <head><style data-reader="overrides">body{font-size:16px;}</style></head>
        <body>
          <article id="epub-viewer">
            <h1 id="ch2-title">第二章：缓存章</h1>
            <p id="ch2-p">预热准备的第二章正文。</p>
          </article>
        </body>
      </html>
    `);
    // 缓存章在 light 下预热
    const spareController = createReaderTheme({
      doc: doc2,
      theme: "light",
    });

    // 用户在当前可见章切到 dark
    pagedController.update("dark");
    // 提升缓存章前，同步将其主题刷到 dark
    spareController.update("dark");
    expect(doc2.querySelector('style[data-reader="theme"]')?.textContent).toContain(
      READER_PALETTES.dark.background,
    );

    // 提升发生：旧活跃章 (doc1) 释放，新章 (doc2) 成为活跃
    pagedController.dispose();

    // 阶段 3：连续滚动同屏多章
    const { document: scrollDocA } = parseHTML(`
      <html><body><article id="epub-viewer"><p id="sa">滚动章 A</p></article></body></html>
    `);
    const { document: scrollDocB } = parseHTML(`
      <html><body><article id="epub-viewer"><p id="sb">滚动章 B</p></article></body></html>
    `);
    const scrollControllerA = createReaderTheme({ doc: scrollDocA, theme: "dark" });
    const scrollControllerB = createReaderTheme({ doc: scrollDocB, theme: "dark" });

    // 同屏切换主题为 sepia
    scrollControllerA.update("sepia");
    scrollControllerB.update("sepia");
    expect(scrollDocA.querySelector('style[data-reader="theme"]')?.textContent).toContain(
      READER_PALETTES.sepia.background,
    );
    expect(scrollDocB.querySelector('style[data-reader="theme"]')?.textContent).toContain(
      READER_PALETTES.sepia.background,
    );

    // 阶段 4：从连续滚动切回分页模式
    scrollControllerA.dispose();
    scrollControllerB.dispose();
    spareController.dispose();

    // 分页模式新挂载的章节以最新 sepia 主题初始化
    const { document: returnPagedDoc } = parseHTML(`
      <html><body><article id="epub-viewer"><p id="rp">回分页正文</p></article></body></html>
    `);
    const returnController = createReaderTheme({ doc: returnPagedDoc, theme: "sepia" });
    expect(returnPagedDoc.querySelector('style[data-reader="theme"]')?.textContent).toContain(
      READER_PALETTES.sepia.background,
    );
    returnController.dispose();
    expect(returnPagedDoc.querySelector('style[data-reader="theme"]')).toBeNull();
  });

  it("防抖前字号变更后切主题：字号重载不被跳过，确保字号确实生效 (R1)", async () => {
    // 初始状态：槽位实际已应用 16px、light 主题
    const initialSettings: ReaderSettings = { ...DEFAULT_SETTINGS, fontSizePx: 16, theme: "light" };
    let desiredSettings: ReaderSettings = initialSettings;

    const { document } = parseHTML("<html><body><p>章节正文</p></body></html>");
    const themeController = createReaderTheme({ doc: document, theme: "light" });

    let reloadCallCount = 0;
    let lastReloadTarget: ReaderSettings | null = null;

    const mockSlot = {
      key: "0:ch1.xhtml",
      status: "ready" as const,
      renderSettings: { ...initialSettings },
      paginator: {
        updateTheme: (theme: any) => {
          themeController.update(theme);
          return true;
        },
        reloadWithSettings: async (settings: ReaderSettings) => {
          reloadCallCount++;
          lastReloadTarget = settings;
        },
        waitForDisplayReady: async () => true,
      },
    };

    // 1. 用户修改字号为 20px（排版几何变化进入防抖队列）
    desiredSettings = { ...initialSettings, fontSizePx: 20 };
    const pendingDebounceTask = async () => {
      // 模拟 reloadSlotSettings：比较实际已应用设置与最新期望设置
      if (sameRenderingSettings(mockSlot.renderSettings, desiredSettings)) return;
      if (sameLayoutSettings(mockSlot.renderSettings, desiredSettings)) {
        if (mockSlot.paginator.updateTheme(desiredSettings.theme)) {
          mockSlot.renderSettings = { ...mockSlot.renderSettings, theme: desiredSettings.theme };
          return;
        }
      }
      const target = desiredSettings;
      await mockSlot.paginator.reloadWithSettings(target);
      await mockSlot.paginator.waitForDisplayReady();
      mockSlot.renderSettings = { ...target };
    };

    // 2. 防抖触发前，用户切换主题为 dark（相邻两次 desired 仅差主题）
    const previousDesired = desiredSettings;
    desiredSettings = { ...desiredSettings, theme: "dark" };
    const changeType = classifySettingsChange(previousDesired, desiredSettings);
    expect(changeType).toBe("theme-only");

    // theme-only 分支执行：必须只更新 theme，绝不能提前将未完成排版的 fontSizePx: 20 写入 slot.renderSettings
    if (changeType === "theme-only") {
      if (mockSlot.paginator.updateTheme(desiredSettings.theme)) {
        mockSlot.renderSettings = { ...mockSlot.renderSettings, theme: desiredSettings.theme };
      }
    }

    // 关键断言 1：slot.renderSettings 仅更新了主题，真实排版字号依然是 16px
    expect(mockSlot.renderSettings.theme).toBe("dark");
    expect(mockSlot.renderSettings.fontSizePx).toBe(16);

    // 3. 防抖队列触发执行
    await pendingDebounceTask();

    // 关键断言 2：字号重载没有被跳过，reloadWithSettings 确实以 20px 执行并生效
    expect(reloadCallCount).toBe(1);
    expect((lastReloadTarget as ReaderSettings | null)?.fontSizePx).toBe(20);
    expect((lastReloadTarget as ReaderSettings | null)?.theme).toBe("dark");
    expect(mockSlot.renderSettings.fontSizePx).toBe(20);
    expect(mockSlot.renderSettings.theme).toBe("dark");

    themeController.dispose();
  });

  it("布局重载进行中主题变更：原位同步最新主题，无需进行第二次布局重载 (R1)", async () => {
    const initialSettings: ReaderSettings = { ...DEFAULT_SETTINGS, fontSizePx: 16, theme: "light" };
    let desiredSettings: ReaderSettings = { ...DEFAULT_SETTINGS, fontSizePx: 20, theme: "light" };

    const { document } = parseHTML("<html><body><p>正文内容</p></body></html>");
    const themeController = createReaderTheme({ doc: document, theme: "light" });

    let reloadCount = 0;
    let inPlaceThemeUpdateCount = 0;

    const mockSlot = {
      key: "0:ch1.xhtml",
      unmounted: false,
      status: "ready" as "loading" | "ready" | "error",
      renderSettings: { ...initialSettings },
      paginator: {
        updateTheme: (theme: any) => {
          inPlaceThemeUpdateCount++;
          themeController.update(theme);
          return true;
        },
        reloadWithSettings: async (_settings: ReaderSettings) => {
          reloadCount++;
          // 模拟在重载进行中，用户将全局主题改为 dark
          desiredSettings = { ...desiredSettings, theme: "dark" };
        },
        waitForDisplayReady: async () => true,
      },
    };

    // 运行 reloadSlotSettings 事务逻辑
    const runReloadSlotSettings = async () => {
      if (mockSlot.unmounted || mockSlot.status !== "ready") return;
      if (sameRenderingSettings(mockSlot.renderSettings, desiredSettings)) return;
      if (sameLayoutSettings(mockSlot.renderSettings, desiredSettings)) {
        if (mockSlot.paginator.updateTheme(desiredSettings.theme)) {
          mockSlot.renderSettings = { ...mockSlot.renderSettings, theme: desiredSettings.theme };
          return;
        }
      }

      do {
        const target = desiredSettings;
        await mockSlot.paginator.reloadWithSettings(target);
        const ready = await mockSlot.paginator.waitForDisplayReady();
        if (mockSlot.unmounted) return;
        if (!ready) {
          mockSlot.status = "error";
          break;
        }
        // 先提交本次真正完成的 layout
        mockSlot.renderSettings = { ...target };
        const latest = desiredSettings;
        if (sameRenderingSettings(mockSlot.renderSettings, latest)) {
          break;
        }
        // 关键协调：仅差主题就原位更新，绝不触发第二次整章重载
        if (sameLayoutSettings(mockSlot.renderSettings, latest)) {
          if (mockSlot.paginator.updateTheme(latest.theme)) {
            mockSlot.renderSettings = { ...mockSlot.renderSettings, theme: latest.theme };
            break;
          }
        }
      } while (!sameRenderingSettings(mockSlot.renderSettings, desiredSettings));
    };

    await runReloadSlotSettings();

    // 关键断言：reloadWithSettings 仅调用了 1 次（没有因为主题变成 dark 而产生第二次整章重载）
    expect(reloadCount).toBe(1);
    // 关键断言：updateTheme 成功原位更新为 dark
    expect(inPlaceThemeUpdateCount).toBe(1);
    expect(mockSlot.renderSettings.fontSizePx).toBe(20);
    expect(mockSlot.renderSettings.theme).toBe("dark");
    expect(themeController.currentTheme).toBe("dark");

    themeController.dispose();
  });

  it("槽位准备/加载中主题变更：就绪/显示前协调最新主题，旧异步结果不覆盖新槽位 (R1)", async () => {
    let desiredSettings: ReaderSettings = { ...DEFAULT_SETTINGS, theme: "light", fontSizePx: 16 };

    const { document: docB } = parseHTML("<html><body><p>新槽位</p></body></html>");

    interface MockActiveSlot {
      id: string;
      generation: number;
      unmounted: boolean;
      status: "loading" | "ready" | "error";
      renderSettings: ReaderSettings;
      paginator: {
        updateTheme: (theme: any) => boolean;
        waitForDisplayReady: () => Promise<boolean>;
      };
    }

    // 槽位 A 开始异步加载（在 light 下发起）
    const slotA: MockActiveSlot = {
      id: "slot-A",
      generation: 1,
      unmounted: false,
      status: "loading",
      renderSettings: { ...desiredSettings },
      paginator: {
        updateTheme: (_theme: any) => true,
        waitForDisplayReady: async () => true,
      },
    };

    // 异步加载中，用户将主题切换为 dark
    desiredSettings = { ...desiredSettings, theme: "dark" };

    // 用户快速跳转，slotA 被废弃 (unmounted)，替换为 slotB (generation: 2)
    slotA.unmounted = true;
    let activeSlot: MockActiveSlot = slotA;

    const themeControllerB = createReaderTheme({ doc: docB, theme: "light" });
    const slotB: MockActiveSlot = {
      id: "slot-B",
      generation: 2,
      unmounted: false,
      status: "loading",
      renderSettings: { ...DEFAULT_SETTINGS, theme: "light", fontSizePx: 16 },
      paginator: {
        updateTheme: (theme: any) => {
          themeControllerB.update(theme);
          return true;
        },
        waitForDisplayReady: async () => true,
      },
    };
    activeSlot = slotB;

    // slotA 的异步结果稍后返回：必须因 unmounted / 身份不符被拒绝，不能提交状态
    const handleSlotReady = (slot: MockActiveSlot) => {
      if (slot.unmounted || activeSlot !== slot) return;
      // 协调最新主题
      if (slot.renderSettings.theme !== desiredSettings.theme && sameLayoutSettings(slot.renderSettings, desiredSettings)) {
        if (slot.paginator.updateTheme(desiredSettings.theme)) {
          slot.renderSettings = { ...slot.renderSettings, theme: desiredSettings.theme };
        }
      }
      slot.status = "ready";
    };

    handleSlotReady(slotA);
    expect(slotA.status).toBe("loading"); // 旧槽位没有被错误标记为 ready

    // slotB 准备完成并提交就绪
    handleSlotReady(slotB);
    expect(slotB.status).toBe("ready");
    // 关键断言：slotB 在就绪显示前已协调为最新 dark 主题
    expect(slotB.renderSettings.theme).toBe("dark");
    expect(themeControllerB.currentTheme).toBe("dark");

    themeControllerB.dispose();
  });

  it("滤镜背景读取实际阅读表面：iframe 内容背景优先，调色板仅作外层底色 (R2)", () => {
    // 模拟 iframe 内部文档拥有作者自定义背景
    const mockContentDoc = {
      body: { style: { backgroundColor: "rgb(253, 246, 226)" } },
      documentElement: { style: {} },
      defaultView: {
        getComputedStyle: (el: any) => ({
          backgroundColor: el === mockContentDoc.body ? "rgb(253, 246, 226)" : "transparent",
        }),
      },
    };

    const mockIframe = {
      contentDocument: mockContentDoc,
      ownerDocument: {
        defaultView: {
          getComputedStyle: () => ({ backgroundColor: "rgb(255, 255, 255)" }),
        },
      },
      closest: () => null,
    } as unknown as HTMLElement;

    // continuousSurfaceBackground 和 readerSurfaceBackground 均应提取 iframe 内的作者背景
    const contBg = continuousSurfaceBackground(mockIframe);
    const pagedBg = readerSurfaceBackground(mockIframe);

    expect(contBg).toBe("rgb(253, 246, 226)");
    expect(pagedBg).toBe("rgb(253, 246, 226)");

    // 若 iframe 内没有设置背景（transparent），则回退到宿主容器背景
    const mockTransparentDoc = {
      body: {},
      documentElement: {},
      defaultView: {
        getComputedStyle: () => ({ backgroundColor: "transparent" }),
      },
    };
    const mockHostContainer = {};
    const mockTransparentIframe = {
      contentDocument: mockTransparentDoc,
      ownerDocument: {
        defaultView: {
          getComputedStyle: (el: any) => ({
            backgroundColor: el === mockHostContainer ? "rgb(240, 240, 240)" : "transparent",
          }),
        },
      },
      closest: (sel: string) => (sel === ".reader" || sel === ".reader-continuous" ? mockHostContainer : null),
    } as unknown as HTMLElement;

    expect(continuousSurfaceBackground(mockTransparentIframe)).toBe("rgb(240, 240, 240)");
    expect(readerSurfaceBackground(mockTransparentIframe)).toBe("rgb(240, 240, 240)");
  });
});
