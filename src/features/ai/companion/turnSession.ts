import type { ReadingLibrary } from "./retrieval";
import { EvidenceRegistry } from "./evidence";
import { buildConversationMessages } from "./prompts";
import { READING_TOOLS, ReadingToolSession } from "./tools";
import { companionDiagnostics } from "./diagnostics";
import { assertContextCapacity, contextLedger, estimateTokens, recentWithinBudget,
  type ContextLedger, type ContextPolicy } from "./contextBudget";
import { selectMemoryContext } from "./memoryContext";
import type { ConversationSegment } from "./conversationStore";
import { recordCompanionEvent } from "./eventLog";
import type { ChatMessage, ChatPhase, ChatTransport, Evidence, InvestigationStep, SavedExchange, ToolCall } from "./types";

export interface ConversationInput {
  question: string; history: readonly SavedExchange[]; memories: string;
  library: ReadingLibrary; transport: ChatTransport; signal: AbortSignal;
  grounded: boolean;
  exchangeId?: string;
  contextPolicy?: ContextPolicy;
  segments?: readonly ConversationSegment[];
  onContext?(ledger: ContextLedger): void;
  onUpdate(phase: ChatPhase, text: string, evidence: readonly Evidence[], trace: readonly InvestigationStep[]): void;
}

/** App-owned context, evidence and diagnostics shared by interchangeable executors. */
export function createTurnSession(input: ConversationInput, runtime: "direct" | "dsh" = "direct") {
  const { library, transport, signal } = input;
  const policy = input.contextPolicy ?? { softLimit: 200000, outputTokens: transport.requestInfo?.maxTokens ?? 8192 };
  const evidence = new EvidenceRegistry(library);
  const selected = recentWithinBudget(input.history, policy.softLimit * 0.95);
  const history = evidence.history(selected, policy.softLimit * 0.2);
  const historicalPassages = evidence.all();
  const memory = selectMemoryContext(input.segments ?? [], input.question, library.context.bookHash, policy.softLimit);
  const prepareRequest = (protocol: ChatMessage[]) => {
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
      const previousCount = history.length;
      const target = Math.min(policy.softLimit * 0.75, capacityInput - 1000);
      let removed = 0;
      while (history.length > 1 && removed < prepared.ledger.inputTokens - target) removed += estimateTokens(history.shift()!);
      prepared = build();
      recordCompanionEvent("context.compacted", { turnId: inspection.id, removedHistory: previousCount - history.length,
        inputTokens: prepared.ledger.inputTokens, softLimit: policy.softLimit });
    }
    assertContextCapacity(prepared.ledger);
    input.onContext?.(prepared.ledger);
    return prepared;
  };
  const inspection = companionDiagnostics.begin(input.question, library.context, transport.requestInfo, input.exchangeId, runtime);
  const update = (phase: ChatPhase, text = "") => input.onUpdate(phase, text, evidence.all(), [...tools.trace]);
  const tools = new ReadingToolSession(library, evidence, signal, phase => update(phase));
  update("planning");
  return {
    evidence, tools, inspection, update, prepareRequest,
    async execute(call: ToolCall) {
      signal.throwIfAborted();
      if (tools.trace.length >= 12) throw new Error("本轮查阅次数较多，请缩小问题后继续");
      inspection.toolStarted(call);
      const result = await tools.execute(call);
      signal.throwIfAborted();
      inspection.tool(call, result);
      update("planning");
      return result;
    },
    checkAnswer(text: string): { continueWith: string } | { answer: string; evidence: Evidence[]; trace: InvestigationStep[] } {
      signal.throwIfAborted();
      let answer = text.trim();
      if (!answer) throw new Error("模型未返回回答");
      const cited = evidence.fromAnswer(answer);
      if (input.grounded && !evidence.all().length) {
        if (!tools.attemptedLookup) return { continueWith: "严格查证对照需要实际原文依据，请调用工具查阅；依据不足就保留判断。" };
        answer = "本次未取得足够的原文依据，暂不作事实判断。可以换线索、检查建库状态或调整阅读范围。";
        return { answer, evidence: [], trace: tools.trace };
      }
      if (input.grounded && !cited.length) return { continueWith: "请将有原文依据的判断关联已有[E编号]，区分原文明示与解释；不能补造细节。" };
      return { answer, evidence: cited, trace: tools.trace };
    },
    fail(error: unknown) {
      inspection.fail(error instanceof Error ? error.message : String(error), signal.aborted);
    },
  };
}
