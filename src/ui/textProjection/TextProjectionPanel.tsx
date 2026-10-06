import { useEffect, useMemo, useState } from "react";
import { compileTextProjection, projectText } from "../../render/textProjection/compile";
import { duplicateRuleIds, sanitizeTextProjectionPreferences } from "../../render/textProjection/preferences";
import {
  DEFAULT_TEXT_PROJECTION_PREFERENCES,
  type TextProjectionMode,
  type TextProjectionPreferences,
  type TextProjectionRule,
} from "../../render/textProjection/types";
import "./textProjectionPanel.css";

export interface TextProjectionPanelProps {
  /** Fully controlled preference snapshot. */
  preferences: TextProjectionPreferences;
  onChange(next: TextProjectionPreferences): void;
  disabled?: boolean;
}

const MODE_LABELS: Record<TextProjectionMode, string> = {
  original: "原文",
  simplified: "简体显示",
  traditional: "繁体显示",
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
  const duplicates = useMemo(() => duplicateRuleIds(props.preferences.rules), [props.preferences.rules]);

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
    <section className="text-projection-panel" aria-label="字符替换与繁简显示">
      <header className="text-projection-panel__header">
        <div>
          <h2>字符替换 / 繁简显示</h2>
          <p>默认原文；预置转换后再应用你的规则。仅改变阅读显示，不修改原书。</p>
        </div>
        <button type="button" className="text-projection-panel__link" onClick={restoreOriginal} disabled={props.disabled}>
          恢复原文
        </button>
      </header>

      <label className="text-projection-panel__field">
        <span>显示模式</span>
        <select
          value={props.preferences.mode}
          disabled={props.disabled}
          onChange={(event) => updateMode(event.target.value as TextProjectionMode)}
        >
          {Object.entries(MODE_LABELS).map(([mode, label]) => (
            <option key={mode} value={mode}>{label}</option>
          ))}
        </select>
      </label>

      <div className="text-projection-panel__rules-head">
        <div>
          <strong>自定义规则</strong>
          <span>最长 from 优先；同长度按列表顺序。重复 from 使用第一条。</span>
        </div>
        <button type="button" onClick={addRule} disabled={props.disabled}>添加规则</button>
      </div>

      {props.preferences.rules.length === 0 ? (
        <p className="text-projection-panel__empty">暂未添加规则。</p>
      ) : (
        <ol className="text-projection-panel__rules">
          {props.preferences.rules.map((rule, index) => (
            <li key={rule.id} className={duplicates.has(rule.id) ? "is-duplicate" : ""}>
              <label className="text-projection-panel__enabled">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  disabled={props.disabled}
                  onChange={(event) => updateRule(rule.id, { enabled: event.target.checked })}
                />
                <span>启用</span>
              </label>
              <input
                aria-label={`规则 ${index + 1} 原文`}
                value={rule.from}
                placeholder="原文（from）"
                disabled={props.disabled}
                onChange={(event) => updateRule(rule.id, { from: event.target.value })}
              />
              <span className="text-projection-panel__arrow" aria-hidden="true">→</span>
              <input
                aria-label={`规则 ${index + 1} 显示`}
                value={rule.to}
                placeholder="显示（to）"
                disabled={props.disabled}
                onChange={(event) => updateRule(rule.id, { to: event.target.value })}
              />
              <div className="text-projection-panel__row-actions">
                <button type="button" onClick={() => props.onChange({ ...props.preferences, rules: moveRule(props.preferences.rules, index, -1) })} disabled={props.disabled || index === 0} title="上移">↑</button>
                <button type="button" onClick={() => props.onChange({ ...props.preferences, rules: moveRule(props.preferences.rules, index, 1) })} disabled={props.disabled || index === props.preferences.rules.length - 1} title="下移">↓</button>
                <button type="button" onClick={() => removeRule(rule.id)} disabled={props.disabled} title="删除">×</button>
              </div>
              {duplicates.has(rule.id) ? (
                <p className="text-projection-panel__warning">重复 from：将采用列表中第一条；此条不会生效。</p>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      <div className="text-projection-panel__preview">
        <label>
          <span>小预览原文</span>
          <input value={previewSource} disabled={props.disabled} onChange={(event) => setPreviewSource(event.target.value)} />
        </label>
        <div>
          <span>显示结果</span>
          <output>{previewBusy ? "转换中…" : previewDisplay}</output>
        </div>
      </div>
    </section>
  );
}

export { sanitizeTextProjectionPreferences };
