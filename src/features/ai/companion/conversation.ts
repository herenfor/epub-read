import type { ReadingLibrary } from "./retrieval";
import { EvidenceRegistry } from "./evidence";
import { buildConversationMessages } from "./prompts";
import { READING_TOOLS, ReadingToolSession } from "./tools";
import type { ChatPhase, ChatTransport, Evidence, InvestigationStep, SavedExchange } from "./types";

export interface ConversationInput {
  question: string; history: readonly SavedExchange[]; memories: string;
  library: ReadingLibrary; transport: ChatTransport; signal: AbortSignal;
  grounded: boolean;
  onUpdate(phase: ChatPhase, text: string, evidence: readonly Evidence[], trace: readonly InvestigationStep[]): void;
}

/** A bounded tool loop. Prompting, evidence, tool dispatch and retrieval are independent modules. */
export async function answerWithBooks(input: ConversationInput): Promise<{ answer: string; evidence: Evidence[]; trace: InvestigationStep[] }> {
  const { library, transport, signal } = input;
  const evidence = new EvidenceRegistry(library);
  const history = evidence.history(input.history);
  const messages = buildConversationMessages({ context: library.context, memories: input.memories, strict: input.grounded,
    evidence, history, question: input.question });
  const update = (phase: ChatPhase, text = "") => input.onUpdate(phase, text, evidence.all(), [...tools.trace]);
  const tools = new ReadingToolSession(library, evidence, signal, phase => update(phase));
  update("planning");
  for (let round = 0; round < 6; round++) {
    signal.throwIfAborted();
    const reply = await transport.complete(messages, READING_TOOLS, signal, text => update("answering", text));
    messages.push(reply);
    if (!reply.tool_calls?.length) {
      const answer = reply.content?.trim();
      if (!answer) throw new Error("模型未返回回答");
      const cited = evidence.fromAnswer(answer);
      if (input.grounded && !evidence.all().length) {
        if (tools.attemptedLookup) return { answer: "本次未取得足够的原文依据，暂不作事实判断。可以换线索、检查建库状态或调整阅读范围。", evidence: [], trace: tools.trace };
        messages.push({ role: "user", content: "严格查证对照需要实际原文依据，请调用工具查阅；依据不足就保留判断。" });
        continue;
      }
      if (input.grounded && !cited.length) {
        messages.push({ role: "user", content: "请将有原文依据的判断关联已有[E编号]，区分原文明示与解释；不能补造细节。" });
        continue;
      }
      // In automatic mode, casual replies do not need a tool call or a mechanical citation.
      return { answer, evidence: cited, trace: tools.trace };
    }
    for (const call of reply.tool_calls) {
      if (tools.trace.length >= 12) throw new Error("本轮查阅次数较多，请缩小问题后继续");
      const result = await tools.execute(call);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      update("planning");
      if (messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0) > 100_000) {
        throw new Error("本轮查阅量较大，请缩小问题；已取得的出处仍可查看");
      }
    }
  }
  throw new Error("本轮查阅次数已用完，请将问题缩小到人物、章节或事件后继续");
}
