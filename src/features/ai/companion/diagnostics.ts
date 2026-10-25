import { isAiDevelopmentActionsAllowed } from "../../../config/appBuildSession";
import { sourcePayload } from "./evidence";
import { COMPANION_PROMPT_VERSION } from "./prompts";
import type { ChatMessage, ChatRequestInfo, Evidence, ReadingContext, SavedExchange, ToolCall } from "./types";
import type { ContextLedger } from "./contextBudget";
import type { ConversationSegment, MemoryEntry } from "./conversationStore";
import { observeCompanionEvents, recordCompanionEvent, type CompanionEventDetails,
  type CompanionEventType, type EventLogSnapshot } from "./eventLog";

interface ContextMaterial {
  history: Array<{ id: string; revision: number; question: string; answer: string; createdAt: number; context?: ReadingContext; interrupted: boolean }>;
  summaries: Array<Pick<ConversationSegment, "id" | "version" | "summary" | "openTopics" | "sources">>;
  memories: MemoryEntry[];
}

const diagnosticSource = (source: Evidence) => ({ ...sourcePayload(source), chunkId: source.hit.chunkId,
  corpusVersion: source.corpusVersion, textAnchor: { start: source.hit.textAnchor.start, end: source.hit.textAnchor.end } });

interface DiagnosticTurn {
  id: string;
  question: string;
  context: ReadingContext;
  requestInfo?: ChatRequestInfo;
  promptVersion: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "complete" | "error" | "cancelled";
  requests: Array<{ startedAt: number; finishedAt?: number; suppliedEvidenceIds: string[]; messageCount: number; reasoningReceived?: boolean; context?: ContextLedger }>;
  tools: Array<{ startedAt: number; finishedAt: number; name: string; arguments: unknown; result: unknown }>;
  evidence: ReturnType<typeof diagnosticSource>[];
  contextMaterial?: ContextMaterial;
  answer?: string;
  error?: string;
}

/** Only selected diagnostic fields enter this in-memory snapshot; no HTTP request or key is accepted. */
export function createDiagnosticRecorder(changed: () => void = () => {},
  event: (type: CompanionEventType, details: CompanionEventDetails) => void = () => {}) {
  const state = { schemaVersion: 1 as const, updatedAt: 0, context: null as ReadingContext | null,
    history: [] as unknown[], turns: [] as DiagnosticTurn[], eventLog: { events: [], persistence: "ready" } as EventLogSnapshot };
  const notify = () => { state.updatedAt = Date.now(); changed(); };
  return {
    snapshot: () => structuredClone(state),
    eventLog(snapshot: EventLogSnapshot) { state.eventLog = snapshot; notify(); },
    history(context: ReadingContext, exchanges: readonly SavedExchange[]) {
      state.context = { ...context };
      state.history = exchanges.slice(-6).map(exchange => ({ question: exchange.question, answer: exchange.answer,
        interrupted: Boolean(exchange.interrupted), trace: exchange.trace ?? [],
        citedEvidence: exchange.evidence.map(diagnosticSource),
        coverage: "Historical citations only; uncited tool results were not retained." }));
      notify();
    },
    begin(question: string, context: ReadingContext, requestInfo?: ChatRequestInfo, exchangeId?: string) {
      const turn: DiagnosticTurn = { id: crypto.randomUUID(), question, context: { ...context },
        startedAt: Date.now(),
        requestInfo: requestInfo && { providerHost: requestInfo.providerHost, model: requestInfo.model,
          thinking: requestInfo.thinking, maxTokens: requestInfo.maxTokens },
        promptVersion: COMPANION_PROMPT_VERSION, status: "running", requests: [], tools: [], evidence: [] };
      state.turns.push(turn); state.turns = state.turns.slice(-3); notify();
      event("turn.started", { turnId: turn.id, exchangeId, bookHash: context.bookHash });
      const toolStarts = new Map<string, number>();
      return {
        id: turn.id,
        request(messages: readonly ChatMessage[], evidence: readonly Evidence[], context?: ContextLedger, material?: ContextMaterial) {
          turn.evidence = evidence.map(diagnosticSource);
          // One selected snapshot per turn; per-request IDs say which records
          // were supplied. No raw assistant/tool protocol or hidden reasoning.
          if (material) {
            const previous = turn.contextMaterial;
            turn.contextMaterial = structuredClone({
              history: [...new Map([...(previous?.history ?? []), ...material.history].map(item => [item.id, item])).values()],
              summaries: [...new Map([...(previous?.summaries ?? []), ...material.summaries].map(item => [item.id, item])).values()],
              memories: [...new Map([...(previous?.memories ?? []), ...material.memories].map(item => [item.id, item])).values()],
            });
          }
          turn.requests.push({ startedAt: Date.now(), suppliedEvidenceIds: evidence.map(source => source.id), messageCount: messages.length,
            ...(context ? { context: structuredClone(context) } : {}) }); notify();
          event("model.requested", { turnId: turn.id, request: turn.requests.length, inputTokens: context?.inputTokens,
            softLimit: context?.softLimit, evidenceCount: evidence.length });
        },
        reply(message: ChatMessage) {
          const request = turn.requests[turn.requests.length - 1];
          request.reasoningReceived = Boolean(message.reasoning_content); request.finishedAt = Date.now(); notify();
          event("model.completed", { turnId: turn.id, request: turn.requests.length,
            elapsedMs: request.finishedAt - request.startedAt, answerCharacters: message.content?.length ?? 0 });
        },
        toolStarted(call: ToolCall) {
          toolStarts.set(call.id, Date.now());
          event("tool.started", { turnId: turn.id, tool: call.function.name });
        },
        tool(call: ToolCall, result: unknown) {
          let args: Record<string, unknown> = {};
          try {
            const parsed: unknown = JSON.parse(call.function.arguments);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
          } catch { /* Execution already reports invalid JSON. */ }
          const fields = ["queries", "query", "bookHash", "chapterPath", "offset", "aroundEvidenceId"];
          const finishedAt = Date.now();
          turn.tools.push({ startedAt: toolStarts.get(call.id) ?? finishedAt, finishedAt, name: call.function.name,
            arguments: Object.fromEntries(fields.filter(key => Object.hasOwn(args, key)).map(key => [key, args[key]])),
            result: structuredClone(result) }); notify();
          event("tool.completed", { turnId: turn.id, tool: call.function.name,
            elapsedMs: finishedAt - (toolStarts.get(call.id) ?? finishedAt) });
        },
        finish(answer: string, evidence: readonly Evidence[]) {
          turn.status = "complete"; turn.finishedAt = Date.now(); turn.answer = answer; turn.evidence = evidence.map(diagnosticSource); notify();
          event("turn.completed", { turnId: turn.id, elapsedMs: turn.finishedAt - turn.startedAt, evidenceCount: evidence.length });
        },
        fail(error: string, cancelled: boolean) {
          turn.status = cancelled ? "cancelled" : "error"; turn.finishedAt = Date.now(); turn.error = error; notify();
          event(cancelled ? "turn.cancelled" : "turn.failed", { turnId: turn.id, elapsedMs: turn.finishedAt - turn.startedAt });
        },
      };
    },
  };
}

let publishing = false;
let dirty = false;
const recorder = createDiagnosticRecorder(() => {
  if (!import.meta.env.DEV || !isAiDevelopmentActionsAllowed() || typeof window === "undefined"
    || !["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname)) return;
  dirty = true;
  if (publishing) return;
  publishing = true;
  queueMicrotask(async () => {
    // Publish serially so an older request cannot replace a newer evidence set.
    while (dirty) {
      dirty = false;
      await fetch("/__ai-companion/diagnostics", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(recorder.snapshot()) }).catch(() => {});
    }
    publishing = false;
  });
}, recordCompanionEvent);
let observingEvents = false;
export function startCompanionEventDiagnostics(): void {
  if (observingEvents || typeof indexedDB === "undefined" || !isAiDevelopmentActionsAllowed()) return;
  observingEvents = true;
  observeCompanionEvents(snapshot => recorder.eventLog(snapshot));
}
export const companionDiagnostics = recorder;
