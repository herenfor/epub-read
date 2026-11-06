import { describe, expect, it } from "vitest";
import ts from "typescript";
import appSource from "../App.tsx?raw";

interface EffectCall {
  start: number;
  deps: string;
  callback: string;
}

function effectCalls(): EffectCall[] {
  const source = ts.createSourceFile("App.tsx", appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const calls: EffectCall[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "useEffect"
      && node.arguments.length >= 2
    ) {
      calls.push({
        start: node.getStart(source),
        deps: node.arguments[1].getText(source).replace(/\s+/g, " "),
        callback: node.arguments[0].getText(source),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

describe("reader tab pending open", () => {
  it("runs the session cleanup effect before the pending tab opens", () => {
    const calls = effectCalls();
    const cleanup = calls.find((call) => call.deps === "[view]" && call.callback.includes('dispatchReaderSession({ type: "leave" })'));
    const pending = calls.find((call) => call.callback.includes("takePendingOpen()"));
    expect(cleanup, "session cleanup effect is missing").toBeDefined();
    expect(pending, "pending tab open effect is missing").toBeDefined();
    // React runs passive effects in declaration order within the same commit.
    // Both run when view becomes "shelf", so the old session must clean up first.
    expect(cleanup!.start).toBeLessThan(pending!.start);
    expect(pending!.deps).toBe("[handleShelfOpen, view]");
    expect(pending!.callback).not.toContain("pendingTabOpenRef");
  });
});
