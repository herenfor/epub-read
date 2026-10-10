import type { Translate, TranslatePlural } from "../../../ui/localization/UiLanguageProvider";

export interface MessageTools {
  t: Translate;
  tn: TranslatePlural;
}

/** Panel status kept as a recipe, so it re-renders in the current UI language. */
export interface LiveMessage {
  render(tools: MessageTools): string;
}

export const liveMessage = (render: (tools: MessageTools) => string): LiveMessage => ({ render });

/** Runtime/diagnostic text that is shown as-is. */
export const rawMessage = (text: string): LiveMessage => ({ render: () => text });
