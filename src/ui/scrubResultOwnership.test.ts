import { createElement, useRef, useState } from "react";
import { expect, it, vi } from "vitest";
import ts from "typescript";
import appSource from "../App.tsx?raw";
import { createReactDomHarness } from "../test/reactDomHarness";
import { useReaderSession, type ReaderSessionHost } from "./useReaderSession";
import { initialScrubUi, reduceScrubUi, type ScrubToken, type ScrubUiEvent, type ScrubUiState } from "./readerProgressAxis";

// Exercise App's actual callbacks without mounting its unrelated library/native UI.
const tree = ts.createSourceFile("App.tsx", appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const factories = new Map<string, (bindings: Record<string, unknown>) => unknown>();
for (const name of ["dispatchScrub", "acceptsScrubResult", "handleContentFractionSettled", "handleContentFractionCancelled", "handleContentFractionFailed"]) {
  let body = "";
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer && ts.isCallExpression(node.initializer)) {
      body = node.initializer.arguments[0].getText(tree);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  if (!body) throw new Error(`App callback missing: ${name}`);
  const js = ts.transpileModule(`const callback = ${body};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  factories.set(name, (bindings) => new Function(...Object.keys(bindings), `${js}; return callback;`)(...Object.values(bindings)));
}
const bind = <T,>(name: string, bindings: Record<string, unknown>): T => factories.get(name)!(bindings) as T;
type ResultKind = "settled" | "cancelled" | "failed";
type Location = { key: string; spineIndex: number; fraction: number; atEnd: boolean };
const location: Location = { key: "chapter", spineIndex: 0, fraction: 0, atEnd: false };

async function fixture() {
  const dom = createReactDomHarness();
  const notice = vi.fn();
  const ratioAt = vi.fn(() => 0);
  let api!: {
    state: ScrubUiState;
    current(): ScrubUiState;
    dispatch(event: ScrubUiEvent): void;
    result(kind: ResultKind, token: ScrubToken, position?: Location): void;
    session: ReaderSessionHost;
  };
  function Probe() {
    const [state, setScrubUiState] = useState(() => initialScrubUi(0));
    const scrubUiStateRef = useRef(state);
    const session = useReaderSession(() => 0);
    const bindings: Record<string, unknown> = {
      scrubUiStateRef, setScrubUiState, reduceScrubUi,
      dispatchReaderSession: session.dispatchReaderSession,
      contentAxisRef: { current: { ratioAt } },
      setReaderNotice: notice, uiText: (key: string) => key,
    };
    const dispatch = bind<(event: ScrubUiEvent) => void>("dispatchScrub", bindings);
    bindings.dispatchScrub = dispatch;
    bindings.acceptsScrubResult = bind("acceptsScrubResult", bindings);
    const handlers = {
      settled: bind<(token: ScrubToken, position: Location) => void>("handleContentFractionSettled", bindings),
      cancelled: bind<(token: ScrubToken) => void>("handleContentFractionCancelled", bindings),
      failed: bind<(token: ScrubToken) => void>("handleContentFractionFailed", bindings),
    };
    api = { state, current: () => scrubUiStateRef.current, dispatch,
      result: (kind, token, position = location) => handlers[kind](token, position), session };
    return null;
  }
  await dom.render(createElement(Probe));
  return { dom, notice, ratioAt, api: () => api };
}

for (const kind of ["settled", "cancelled", "failed"] as const) it(`ignores ${kind} from an old book or replaced request before any session/notice effects`, async () => {
  const f = await fixture();
  const current = { session: 2, request: 7 };
  try {
    await f.dom.run(() => {
      f.api().dispatch({ type: "reset", session: 2 });
      f.api().dispatch({ type: "begin", token: current, ratio: .8 });
      f.api().session.dispatchReaderSession({ type: "begin-explicit" });
    });
    const before = f.api().current();
    await f.dom.run(() => {
      f.api().result(kind, { session: 1, request: 7 });
      f.api().result(kind, { session: 2, request: 6 });
    });
    expect(f.api().current()).toBe(before);
    expect(f.api().session.navigationPendingRef.current).toBe(true);
    expect(f.api().session.readerDisplayReadyRef.current).toBe(false);
    expect(f.api().session.historyCaptureAllowedRef.current).toBe(false);
    expect(f.notice).not.toHaveBeenCalled();
    expect(f.ratioAt).not.toHaveBeenCalled();
  } finally { await f.dom.dispose(); }
});

for (const kind of ["settled", "cancelled", "failed"] as const) it(`accepts the current ${kind} synchronously after begin, even before React commits`, async () => {
  const f = await fixture();
  const token = { session: 1, request: 1 };
  try {
    await f.dom.run(() => {
      f.api().dispatch({ type: "reset", session: 1 });
      f.api().dispatch({ type: "begin", token, ratio: .8 });
      f.api().session.dispatchReaderSession({ type: "begin-scrub" });
      expect(f.api().current().pending).toMatchObject(token);
      f.api().result(kind, token);
      expect(f.api().current().pending).toBeNull();
    });
    expect(f.api().state).toBe(f.api().current());
    expect(f.api().session.navigationPendingRef.current).toBe(false);
    if (kind === "settled") {
      expect(f.api().state.actual).toEqual({ ratio: 0, atEnd: false });
      expect(f.api().session.readerDisplayReadyRef.current).toBe(true);
    }
    expect(f.notice).toHaveBeenCalledTimes(kind === "failed" ? 1 : 0);
    await f.dom.run(() => {
      f.api().session.dispatchReaderSession({ type: "begin-explicit" });
      f.api().result(kind, token); // already consumed: cannot affect a later navigation
    });
    expect(f.api().session.navigationPendingRef.current).toBe(true);
    expect(f.api().session.readerDisplayReadyRef.current).toBe(false);
    expect(f.notice).toHaveBeenCalledTimes(kind === "failed" ? 1 : 0);
  } finally { await f.dom.dispose(); }
});

it("reset invalidates old cleanup immediately within the same React batch", async () => {
  const f = await fixture();
  const token = { session: 1, request: 1 };
  try {
    await f.dom.run(() => {
      f.api().dispatch({ type: "reset", session: 1 });
      f.api().dispatch({ type: "begin", token, ratio: .5 });
    });
    await f.dom.run(() => {
      f.api().dispatch({ type: "reset", session: 2 });
      f.api().session.dispatchReaderSession({ type: "open" });
      f.api().result("cancelled", token);
      expect(f.api().session.navigationPendingRef.current).toBe(true);
    });
    expect(f.api().state).toEqual(initialScrubUi(2));
  } finally { await f.dom.dispose(); }
});
