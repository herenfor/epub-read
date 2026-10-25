import { READING_TOOLS } from "./tools";
import { createTurnSession, type ConversationInput } from "./turnSession";
import type { ChatMessage } from "./types";
export type { ConversationInput } from "./turnSession";

/** Direct fallback owns this loop; Harness mode never enters it. */
export async function answerWithBooks(input: ConversationInput) {
  const session = createTurnSession(input);
  const protocol: ChatMessage[] = [];
  try {
    for (let round = 0; round < 6; round++) {
      input.signal.throwIfAborted();
      const { messages, ledger, material } = session.prepareRequest(protocol);
      session.inspection.request(messages, session.evidence.all(), ledger, material);
      const reply = await input.transport.complete(messages, READING_TOOLS, input.signal,
        text => session.update("answering", text));
      input.signal.throwIfAborted();
      session.inspection.reply(reply);
      protocol.push(reply);
      if (!reply.tool_calls?.length) {
        const result = session.checkAnswer(reply.content ?? "");
        if ("continueWith" in result) { protocol.push({ role: "user", content: result.continueWith }); continue; }
        session.inspection.finish(result.answer, session.evidence.all());
        return result;
      }
      for (const call of reply.tool_calls) {
        const result = await session.execute(call);
        protocol.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    throw new Error("本轮查阅次数已用完，请将问题缩小到人物、章节或事件后继续");
  } catch (error) { session.fail(error); throw error; }
}
