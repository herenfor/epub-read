import type { ReadingLibrary } from "./retrieval";
import { EvidenceRegistry } from "./evidence";
import { buildConversationMessages } from "./prompts";
import { READING_TOOLS, ReadingToolSession } from "./tools";
import { companionDiagnostics } from "./diagnostics";
import { assertContextCapacity, contextLedger, estimateTokens, recentWithinBudget,
  type ContextLedger, type ContextPolicy } from "./contextBudget";
import { selectMemoryContext } from "./memoryContext";
import type { ConversationSegment } from "./conversationStore";
import type { ChatPhase, ChatTransport, Evidence, InvestigationStep, SavedExchange } from "./types";

export interface ConversationInput {
  question: string; history: readonly SavedExchange[]; memories: string;
  library: ReadingLibrary; transport: ChatTransport; signal: AbortSignal;
  grounded: boolean;
  contextPolicy?: ContextPolicy;
  segments?: readonly ConversationSegment[];
  onContext?(ledger: ContextLedger): void;
  onUpdate(phase: ChatPhase, text: string, evidence: readonly Evidence[], trace: readonly InvestigationStep[]): void;
}

/** A bounded tool loop. Prompting, evidence, tool dispatch and retrieval are independent modules. */
export async function answerWithBooks(input: ConversationInput): Promise<{ answer: string; evidence: Evidence[]; trace: InvestigationStep[] }> {
  const { library, transport, signal } = input;
  const policy = input.contextPolicy ?? { softLimit: 200000, outputTokens: transport.requestInfo?.maxTokens ?? 8192 };
  const evidence = new EvidenceRegistry(library);
  const selected = recentWithinBudget(input.history, policy.softLimit * 0.95);
  const history = evidence.history(selected, policy.softLimit * 0.2);
  const historicalPassages = evidence.all();
  const memory = selectMemoryContext(input.segments ?? [], input.question, library.context.bookHash, policy.softLimit);
  const protocol: import("./types").ChatMessage[] = [];
  const prepareRequest = () => {
    const build = () => {
      const rawIds = new Set(history.map(exchange => exchange.id));
      const summaries = memory.summaries.filter(segment => segment.sources.some(source => !rawIds.has(source.exchangeId)));
      const messages = [...buildConversationMessages({ context: library.context, memories: input.memories, strict: input.grounded,
        evidence, passages: historicalPassages, history, question: input.question,
        summaries, automaticMemories: memory.memories }), ...protocol];
      const ledger = contextLedger(messages, READING_TOOLS, policy, { historyIds: history.map(exchange => exchange.id),
        segmentIds: summaries.map(segment => segment.id), memoryIds: memory.memories.map(entry => entry.id),
        omittedHistory: input.history.length - history.length });
      return { messages, ledger, material: { history: [...history], summaries: summaries.map(segment => ({ id: segment.id,
        version: segment.version, summary: segment.summary, openTopics: segment.openTopics, sources: segment.sources })),
        memories: memory.memories } };
    };
    let prepared = build();
    const capacityInput = policy.capacity ? policy.capacity - policy.outputTokens - 16384 : Infinity;
    // Completed historical dialogue can be shed between tool requests; the
    // current protocol tail and its actual reasoning fields stay intact.
    if ((prepared.ledger.overSoftLimit || prepared.ledger.inputTokens > capacityInput) && history.length > 1) {
      const target = Math.min(policy.softLimit * 0.75, capacityInput - 1000);
      let removed = 0;
      while (history.length > 1 && removed < prepared.ledger.inputTokens - target) removed += estimateTokens(history.shift()!);
      prepared = build();
    }
    assertContextCapacity(prepared.ledger);
    input.onContext?.(prepared.ledger);
    return prepared;
  };
  const inspection = companionDiagnostics.begin(input.question, library.context, transport.requestInfo);
  const update = (phase: ChatPhase, text = "") => input.onUpdate(phase, text, evidence.all(), [...tools.trace]);
  const tools = new ReadingToolSession(library, evidence, signal, phase => update(phase));
  update("planning");
  try {
    for (let round = 0; round < 6; round++) {
      signal.throwIfAborted();
      const { messages, ledger, material } = prepareRequest();
      inspection.request(messages, evidence.all(), ledger, material);
      const reply = await transport.complete(messages, READING_TOOLS, signal, text => update("answering", text));
      inspection.reply(reply);
      protocol.push(reply);
      if (!reply.tool_calls?.length) {
        const answer = reply.content?.trim();
        if (!answer) throw new Error("模型未返回回答");
        const cited = evidence.fromAnswer(answer);
        if (input.grounded && !evidence.all().length) {
          if (tools.attemptedLookup) {
            const answer = "本次未取得足够的原文依据，暂不作事实判断。可以换线索、检查建库状态或调整阅读范围。";
            inspection.finish(answer, evidence.all());
            return { answer, evidence: [], trace: tools.trace };
          }
          protocol.push({ role: "user", content: "严格查证对照需要实际原文依据，请调用工具查阅；依据不足就保留判断。" });
          continue;
        }
        if (input.grounded && !cited.length) {
          protocol.push({ role: "user", content: "请将有原文依据的判断关联已有[E编号]，区分原文明示与解释；不能补造细节。" });
          continue;
        }
        // In automatic mode, casual replies do not need a tool call or a mechanical citation.
        inspection.finish(answer, evidence.all());
        return { answer, evidence: cited, trace: tools.trace };
      }
      for (const call of reply.tool_calls) {
        if (tools.trace.length >= 12) throw new Error("本轮查阅次数较多，请缩小问题后继续");
        const result = await tools.execute(call);
        inspection.tool(call, result);
        protocol.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        update("planning");
      }
    }
    throw new Error("本轮查阅次数已用完，请将问题缩小到人物、章节或事件后继续");
  } catch (error) {
    inspection.fail(error instanceof Error ? error.message : String(error), signal.aborted);
    throw error;
  }
}
