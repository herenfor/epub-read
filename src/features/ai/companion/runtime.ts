import { answerWithBooks, type ConversationInput } from "./conversation";
import type { ChatTransport } from "./types";

export const COMPANION_CONVERSATION_ID = "reading-companion:main";

/** App-owned conversation data and book permissions stay outside the engine.
 * An external harness adapter implements this port, not ChatTransport: a harness
 * already owns a model/tool loop and must not be nested inside another loop. */
export interface CompanionRuntime {
  runTurn(input: Omit<ConversationInput, "transport">): ReturnType<typeof answerWithBooks>;
}
export function createDirectRuntime(transport: ChatTransport): CompanionRuntime {
  return { runTurn: input => answerWithBooks({ ...input, transport }) };
}
