import { createTurnSession } from "../turnSession";
import type { CompanionRuntime } from "../runtime";
import { READING_TOOLS } from "../tools";
import type { ChatTransport } from "../types";
import { runHarness } from "./channel";

export function createHarnessRuntime(transport: ChatTransport): CompanionRuntime {
  return { async runTurn(input) {
    const session = createTurnSession({ ...input, transport }, "dsh");
    let checked: ReturnType<typeof session.checkAnswer> | undefined;
    try {
      // The DSH session owns only this turn. Canonical role/history/200K budget
      // are projected once by the app at every actual provider request.
      const initial = session.prepareRequest([]);
      await runHarness({ id: input.exchangeId ?? crypto.randomUUID(), model: transport.requestInfo?.model ?? "configured-model",
        system: initial.messages[0].content ?? "", question: input.question, tools: READING_TOOLS,
        maxTokens: transport.requestInfo?.maxTokens ?? 8192 }, input.signal, async request => {
        input.signal.throwIfAborted();
        if (request.kind === "tool") return session.execute(request.data);
        if (request.kind === "finalize") {
          checked = session.checkAnswer(request.data.answer);
          return "continueWith" in checked ? checked : {};
        }
        const { messages, ledger, material } = session.prepareRequest(request.data.protocol);
        session.inspection.request(messages, session.evidence.all(), ledger, material);
        const reply = await transport.complete(messages, READING_TOOLS, input.signal, text => session.update("answering", text));
        input.signal.throwIfAborted();
        session.inspection.reply(reply);
        return reply;
      });
      input.signal.throwIfAborted();
      if (!checked || "continueWith" in checked) throw new Error("DSH回答尚未完成查证");
      session.inspection.finish(checked.answer, session.evidence.all());
      return checked;
    } catch (error) { session.fail(error); throw error; }
  } };
}
