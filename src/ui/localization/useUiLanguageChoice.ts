import { useState } from "react";
import type { UiLanguagePreference } from "./core";
import { useUiText } from "./UiLanguageProvider";

/** Shared logic for every "界面语言" setting row; hosts only choose the control style. */
export function useUiLanguageChoice() {
  const { t, preference, setPreference } = useUiText();
  const [error, setError] = useState<string | null>(null);
  const options: Array<{ value: UiLanguagePreference; label: string }> = [
    { value: "zh-CN", label: t("language.zh-CN") },
    { value: "en", label: t("language.en") },
    { value: "system", label: t("language.system") },
  ];
  const choose = (value: UiLanguagePreference): void => {
    try {
      setPreference(value);
      setError(null);
    } catch (cause) {
      // The previous language stays active; never imply the choice was saved.
      setError(t("language.saveFailed", { error: String(cause) }));
    }
  };
  return { label: t("language.setting"), preference, options, choose, error };
}
