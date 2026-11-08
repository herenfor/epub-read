import { describe, expect, it } from "vitest";
import { applyUiScale, isValidUiScale, UI_SCALE_PROPERTY } from "./uiScale";

// Every stylesheet and UI source as text (see cssTokens.test.ts for why they are read from disk).
const fs: { readFileSync(path: URL, encoding: "utf8"): string } = await import("node:" + "fs");
const read = (paths: Record<string, unknown>) =>
  Object.fromEntries(Object.keys(paths).map((path) => [path, fs.readFileSync(new URL(path, import.meta.url), "utf8")]));
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const styles = Object.fromEntries(Object.entries(read(import.meta.glob("../**/*.css"))).map(([path, css]) => [path, stripComments(css)]));
// Book-frame styles under render/ size the book, not the UI, so they stay out of the scan.
const sources = read(import.meta.glob(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}", "!../render/**"]));

const TOKENS = "./uiTokens.css";

describe("UI scale (ER-0127)", () => {
  it("reads the whole app", () => {
    expect(styles[TOKENS]).toBeDefined();
    expect(Object.keys(styles).length).toBeGreaterThan(30);
    expect(Object.keys(sources).length).toBeGreaterThan(100);
  });

  it("sizes all UI text from the scaled tokens", () => {
    const literals = Object.entries(styles).flatMap(([path, css]) => [
      ...[...css.matchAll(/font-size\s*:\s*[\d.]+px/g)].map((m) => `${path}: ${m[0]}`),
      ...[...css.matchAll(/(?<![\w-])font\s*:[^;}]*?\b[\d.]+px/g)].map((m) => `${path}: ${m[0]}`),
    ]);
    const inline = Object.entries(sources)
      .flatMap(([path, code]) => [...code.matchAll(/fontSize\s*:\s*["'`]?[\d.]+(?:px)?["'`]?\s*[,}]/g)].map((m) => `${path}: ${m[0]}`));
    expect([...literals, ...inline]).toEqual([]);
  });

  it("never scales a container with zoom", () => {
    const zooms = Object.entries(styles).flatMap(([path, css]) =>
      [...css.matchAll(/(?<![\w-])zoom\s*:\s*([^;}]+)/g)]
        .filter(() => path !== TOKENS)
        .map((m) => `${path}: zoom: ${m[1].trim()}`));
    expect(zooms).toEqual([]);
    // The one zoom left is the inline icon rule, and it reads the scale.
    expect([...styles[TOKENS].matchAll(/(?<![\w-])zoom\s*:\s*([^;}]+)/g)].map((m) => m[1].trim())).toEqual(["var(--ui-scale, 1)"]);
  });

  it("sets the scale in one place", () => {
    const writers = [
      ...Object.entries(styles).filter(([path, css]) => path !== TOKENS && /--ui-scale\s*:/.test(css)).map(([path]) => path),
      ...Object.entries(sources).filter(([path, code]) => path !== "./uiScale.ts" && /["'`]--ui-scale["'`]/.test(code)).map(([path]) => path),
    ];
    expect(writers).toEqual([]);
  });

  it("derives every text token from the scale", () => {
    for (const token of ["micro", "caption", "body", "emph", "title"]) {
      expect(styles[TOKENS]).toMatch(new RegExp(`--fs-${token}:\\s*calc\\(\\d+px \\* var\\(--ui-scale\\)\\)`));
    }
  });

  it("writes only valid scales to the root", () => {
    const root = { style: { values: new Map<string, string>(), setProperty(name: string, value: string) { this.values.set(name, value); } } };
    applyUiScale(1.3, root as unknown as HTMLElement);
    expect(root.style.values.get(UI_SCALE_PROPERTY)).toBe("1.3");
    applyUiScale(Number.NaN, root as unknown as HTMLElement);
    expect(root.style.values.get(UI_SCALE_PROPERTY)).toBe("1");
    applyUiScale(3, root as unknown as HTMLElement);
    expect(root.style.values.get(UI_SCALE_PROPERTY)).toBe("1");
    expect(isValidUiScale(0.75)).toBe(true);
    expect(isValidUiScale(1.5)).toBe(true);
    expect(isValidUiScale(0.5)).toBe(false);
    expect(isValidUiScale("1")).toBe(false);
  });
});
