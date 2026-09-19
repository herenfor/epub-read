import { useEffect, useRef } from "react";
import type { TocNode } from "../core/types";
import { splitHref } from "../core/paths";
import { CloseIcon, WarningCircleIcon } from "./readerIcons";

export interface TocPanelProps {
  toc: TocNode[];
  /** 当前阅读位置的内部 href（路径可带 fragment，用于高亮） */
  activeHref?: string;
  onNavigate(href: string): void;
  onClose(): void;
}

/** 递归统计目录项，包含所有层级而不只是顶层章节。 */
export function countTocNodes(nodes: TocNode[]): number {
  return nodes.reduce((count, node) => count + 1 + countTocNodes(node.children), 0);
}

/**
 * 找唯一活动目录项：fragment 精确匹配优先；否则同路径的章首项，再退回
 * 同路径第一项。返回节点引用供渲染层做 identity 比较，避免同章多项同时高亮。
 */
export function findActiveTocNode(
  nodes: TocNode[],
  activeHref?: string
): TocNode | undefined {
  if (!activeHref) return undefined;
  const active = splitHref(activeHref);
  const all: TocNode[] = [];
  const collect = (items: TocNode[]): void => {
    for (const item of items) {
      all.push(item);
      collect(item.children);
    }
  };
  collect(nodes);
  const samePath = all.filter((node) => splitHref(node.href).path === active.path);
  if (samePath.length === 0) return undefined;
  if (active.anchor) {
    const exact = samePath.find((node) => splitHref(node.href).anchor === active.anchor);
    if (exact) return exact;
  }
  return samePath.find((node) => splitHref(node.href).anchor === "") ?? samePath[0];
}

function TocList({
  nodes,
  level,
  activeNode,
  activeItemRef,
  onNavigate,
}: {
  nodes: TocNode[];
  level: number;
  activeNode?: TocNode;
  activeItemRef?: React.RefObject<HTMLDivElement | null>;
  onNavigate(href: string): void;
}) {
  return (
    <div className="toc-list-branch">
      {nodes.map((node, i) => {
        const active = node === activeNode;
        const disabled = node.disabled === true;
        return (
          <div key={`${level}-${i}-${node.label}`}>
            <div
              ref={active ? (activeItemRef as React.Ref<HTMLDivElement>) : undefined}
              className={`toc-item level-${Math.min(level, 3)}${active ? " active" : ""}${disabled ? " disabled" : ""}`}
              style={{
                paddingLeft: `${12 + level * 16}px`,
              }}
              title={disabled ? `无法使用：${node.href || "无有效链接"}` : node.label}
              onClick={() => {
                if (!disabled) onNavigate(node.href);
              }}
            >
              <span className="toc-item-text">{node.label || "(无标题)"}</span>
              {disabled ? <WarningCircleIcon size={13} className="toc-disabled-icon" /> : null}
            </div>
            {node.children.length > 0 ? (
              <TocList
                nodes={node.children}
                level={level + 1}
                activeNode={activeNode}
                activeItemRef={activeItemRef}
                onNavigate={onNavigate}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function TocPanel(props: TocPanelProps) {
  const activeNode = findActiveTocNode(props.toc, props.activeHref);
  const count = countTocNodes(props.toc);
  const activeItemRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeItemRef.current) {
      activeItemRef.current.scrollIntoView({ block: "center", behavior: "auto" });
    }
  }, [activeNode]);

  return (
    <aside className="toc-panel" role="dialog" aria-modal="true" aria-label="目录">
      <div className="drawer-drag-handle" aria-hidden="true" />
      <div className="toc-head">
        <div className="drawer-title-wrap">
          <span className="toc-title">目录</span>
          <span className="toc-count">
            {count > 0 ? `${count} 项` : "无"}
          </span>
        </div>
        <button className="tb-btn tb-close" onClick={props.onClose} title="关闭目录" aria-label="关闭目录">
          <CloseIcon size={14} />
        </button>
      </div>
      {props.toc.length === 0 ? (
        <div className="toc-empty">（本书无目录）</div>
      ) : (
        <div className="toc-content">
          <TocList
            nodes={props.toc}
            level={0}
            activeNode={activeNode}
            activeItemRef={activeItemRef}
            onNavigate={props.onNavigate}
          />
        </div>
      )}
    </aside>
  );
}
