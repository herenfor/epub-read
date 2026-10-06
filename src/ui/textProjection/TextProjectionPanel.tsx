import { useEffect, useMemo, useState } from "react";
import { compileTextProjection, projectText } from "../../render/textProjection/compile";
import { duplicateRuleIds, sanitizeTextProjectionPreferences } from "../../render/textProjection/preferences";
import {
  DEFAULT_TEXT_PROJECTION_PREFERENCES,
  type TextProjectionMode,
  type TextProjectionPreferences,
  type TextProjectionRule,
} from "../../render/textProjection/types";
import { ChevronDownIcon, CloseIcon, PlusIcon, RotateCcwIcon } from "../readerIcons";
import "./textProjectionPanel.css";

export interface TextProjectionPanelProps {
  /** Fully controlled preference snapshot. */
  preferences: TextProjectionPreferences;
  onChange(next: TextProjectionPreferences): void;
  disabled?: boolean;
}

const MODE_LABELS: Record<TextProjectionMode, string> = {
  original: "原文",
  simplified: "简体",
  traditional: "繁体",
};

function createRuleId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && "randomUUID" in cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return `rule-${cryptoObj.randomUUID()}`;
  }
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function moveRule(rules: readonly TextProjectionRule[], index: number, delta: -1 | 1): TextProjectionRule[] {
  const target = index + delta;
  if (target < 0 || target >= rules.length) return [...rules];
  const next = [...rules];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

export function TextProjectionPanel(props: TextProjectionPanelProps) {
  const [previewSource, setPreviewSource] = useState("阅读器的里外：後面");
  const [previewDisplay, setPreviewDisplay] = useState(previewSource);
  const [previewBusy, setPreviewBusy] = useState(false);
  // Unfinished drafts (empty from) are not real duplicates.
  const duplicates = useMemo(
    () => duplicateRuleIds(props.preferences.rules.filter((rule) => rule.from.trim().length > 0)),
    [props.preferences.rules],
  );

  useEffect(() => {
    let current = true;
    setPreviewBusy(true);
    void compileTextProjection(props.preferences)
      .then((compiled) => {
        if (!current) return;
        setPreviewDisplay(projectText(previewSource, compiled));
      })
      .catch(() => {
        if (current) setPreviewDisplay("预览失败");
      })
      .finally(() => {
        if (current) setPreviewBusy(false);
      });
    return () => {
      current = false;
    };
  }, [props.preferences, previewSource]);

  const updateMode = (mode: TextProjectionMode): void => {
    props.onChange({ ...props.preferences, mode });
  };

  const updateRule = (id: string, patch: Partial<TextProjectionRule>): void => {
    props.onChange({
      ...props.preferences,
      rules: props.preferences.rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
    });
  };

  const addRule = (): void => {
    const rule: TextProjectionRule = { id: createRuleId(), from: "", to: "", enabled: true };
    props.onChange({ ...props.preferences, rules: [...props.preferences.rules, rule] });
  };

  const removeRule = (id: string): void => {
    props.onChange({
      ...props.preferences,
      rules: props.preferences.rules.filter((rule) => rule.id !== id),
    });
  };

  const restoreOriginal = (): void => {
    // Keep user rules for later editing but disable them so "原文" is literal.
    props.onChange({
      ...DEFAULT_TEXT_PROJECTION_PREFERENCES,
      rules: props.preferences.rules.map((rule) => ({ ...rule, enabled: false })),
    });
  };

  return (
    <section className="rd-section text-projection-panel" aria-label="字符替换与繁简显示">
      <div className="aa-group-title">字符显示</div>
      <p className="rd-note">只改变阅读显示，不修改原书；先繁简转换，再套用下方规则。</p>

      <div className="aa-control-row">
        <span className="aa-section-label">繁简</span>
        <div className="aa-segmented-capsule" role="radiogroup" aria-label="显示模式">
          {(Object.keys(MODE_LABELS) as TextProjectionMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={props.preferences.mode === mode}
              className={`aa-segmented-btn${props.preferences.mode === mode ? " active" : ""}`}
              disabled={props.disabled}
              onClick={() => updateMode(mode)}
            >
              {MODE_LABELS[mode]}
            </button>
          ))}
        </div>
      </div>

      <div className="aa-control-row">
        <div className="aa-detail-label-wrap">
          <span className="aa-section-label">自定义规则</span>
          <span className="aa-detail-sub">最长原文优先，同长按列表顺序</span>
        </div>
        <button type="button" className="aa-mini-action-btn" onClick={addRule} disabled={props.disabled}>
          <PlusIcon size={12} />
          添加
        </button>
      </div>

      {props.preferences.rules.length === 0 ? (
        <p className="text-projection-empty">暂未添加规则</p>
      ) : (
        <ol className="text-projection-rules">
          {props.preferences.rules.map((rule, index) => (
            <li key={rule.id} className={`text-projection-rule${duplicates.has(rule.id) ? " is-duplicate" : ""}${rule.enabled ? "" : " is-off"}`}>
              <div className="text-projection-rule-main">
                <input
                  className="rd-input"
                  aria-label={`规则 ${index + 1} 原文`}
                  value={rule.from}
                  placeholder="原文"
                  disabled={props.disabled}
                  onChange={(event) => updateRule(rule.id, { from: event.target.value })}
                />
                <span className="text-projection-arrow" aria-hidden="true">→</span>
                <input
                  className="rd-input"
                  aria-label={`规则 ${index + 1} 显示`}
                  value={rule.to}
                  placeholder="显示为"
                  disabled={props.disabled}
                  onChange={(event) => updateRule(rule.id, { to: event.target.value })}
                />
              </div>
              <div className="text-projection-rule-actions">
                <label className="aa-switch-label" title={rule.enabled ? "停用此规则" : "启用此规则"}>
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    disabled={props.disabled}
                    aria-label={`启用规则 ${index + 1}`}
                    onChange={(event) => updateRule(rule.id, { enabled: event.target.checked })}
                  />
                  <span className="aa-switch-track" />
                </label>
                <span className="text-projection-rule-state">{rule.enabled ? "启用" : "停用"}</span>
                <span className="text-projection-rule-spacer" />
                <button type="button" className="aa-step-reset-btn" onClick={() => props.onChange({ ...props.preferences, rules: moveRule(props.preferences.rules, index, -1) })} disabled={props.disabled || index === 0} title="上移" aria-label="上移">
                  <ChevronDownIcon size={13} className="text-projection-up" />
                </button>
                <button type="button" className="aa-step-reset-btn" onClick={() => props.onChange({ ...props.preferences, rules: moveRule(props.preferences.rules, index, 1) })} disabled={props.disabled || index === props.preferences.rules.length - 1} title="下移" aria-label="下移">
                  <ChevronDownIcon size={13} />
                </button>
                <button type="button" className="aa-step-reset-btn text-projection-remove" onClick={() => removeRule(rule.id)} disabled={props.disabled} title="删除" aria-label="删除">
                  <CloseIcon size={12} />
                </button>
              </div>
              {duplicates.has(rule.id) ? (
                <p className="text-projection-warning">原文重复：采用列表中第一条，此条不会生效。</p>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      <div className="text-projection-preview">
        <label className="aa-control-row">
          <span className="aa-section-label">预览</span>
          <input className="rd-input" value={previewSource} disabled={props.disabled} onChange={(event) => setPreviewSource(event.target.value)} />
        </label>
        <div className="aa-control-row">
          <span className="aa-section-label">显示</span>
          <output className="text-projection-output">{previewBusy ? "转换中…" : previewDisplay}</output>
        </div>
      </div>

      <div className="rd-actions">
        <button type="button" className="aa-mini-action-btn" onClick={restoreOriginal} disabled={props.disabled}>
          <RotateCcwIcon size={12} />
          恢复原文
        </button>
      </div>
    </section>
  );
}

export { sanitizeTextProjectionPreferences };
