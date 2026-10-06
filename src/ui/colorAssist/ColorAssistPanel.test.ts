import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { correctionMatrix, previewColor, svgMatrixValues, type AssistKind } from "../../render/colorAssist/colorAssistCore";
import { ColorAssistPanel, selectColorAssistKind } from "./ColorAssistPanel";

type AssistColorKind = Exclude<AssistKind, "off">;

const IDENTITY: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const COLOR_ASSIST_KINDS: readonly AssistColorKind[] = ["protan", "deutan", "tritan"];

/** Machado et al. 2009 severity=1 simulation values; FX-2 correction must not be just these. */
const MACHADO_SIMULATION: Record<AssistColorKind, readonly number[]> = {
  protan: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deutan: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.011820, 0.042940, 0.968881],
  tritan: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.303900],
};

describe("FX-2 color assist core", () => {
  it("uses identity for off/zero and keeps SVG alpha identity", () => {
    expect(correctionMatrix("off", 0.8)).toEqual(IDENTITY);
    expect(correctionMatrix("protan", 0)).toEqual(IDENTITY);
    expect(svgMatrixValues(correctionMatrix("tritan", 0)).split(" ").map(Number)).toEqual([
      1, 0, 0, 0, 0,
      0, 1, 0, 0, 0,
      0, 0, 1, 0, 0,
      0, 0, 0, 1, 0,
    ]);
  });

  it("keeps three heuristic corrections distinct from pure simulation", () => {
    for (const kind of COLOR_ASSIST_KINDS) {
      const correction = correctionMatrix(kind, 1);
      expect(correction).not.toEqual(IDENTITY);
      expect(correction).not.toEqual(MACHADO_SIMULATION[kind]);
    }
    expect(new Set(COLOR_ASSIST_KINDS.map((kind) => svgMatrixValues(correctionMatrix(kind, 1)))).size).toBe(3);
  });

  it("preserves neutral colors and alpha in the CPU preview", () => {
    for (const kind of COLOR_ASSIST_KINDS) {
      const [red, green, blue, alpha] = previewColor(correctionMatrix(kind, 1), [0.5, 0.5, 0.5, 0.42]);
      expect(red).toBeCloseTo(0.5, 6);
      expect(green).toBeCloseTo(0.5, 6);
      expect(blue).toBeCloseTo(0.5, 6);
      expect(alpha).toBe(0.42);
    }
  });

  it("round-trips the preview through sRGB/linear and clamps out-of-gamut output", () => {
    const roundTrip = previewColor(correctionMatrix("off", 0), [0.25, 0.5, 0.75, 0.4]);
    expect(roundTrip[0]).toBeCloseTo(0.25, 10);
    expect(roundTrip[1]).toBeCloseTo(0.5, 10);
    expect(roundTrip[2]).toBeCloseTo(0.75, 10);
    expect(roundTrip[3]).toBe(0.4);
    const clampedHigh = previewColor([2, 0, 0, 0, 2, 0, 0, 0, 2], [1, 1, 1, 0.3]);
    expect(clampedHigh[0]).toBeCloseTo(1, 12);
    expect(clampedHigh[1]).toBeCloseTo(1, 12);
    expect(clampedHigh[2]).toBeCloseTo(1, 12);
    expect(clampedHigh[3]).toBe(0.3);
    expect(previewColor([-1, 0, 0, 0, -1, 0, 0, 0, -1], [1, 1, 1, 0.3])).toEqual([0, 0, 0, 0.3]);
  });

  it("serializes the 4x5 SVG matrix from the same row-major correction", () => {
    const matrix = correctionMatrix("deutan", 0.6);
    const values = svgMatrixValues(matrix).split(" ").map(Number);
    expect(values).toEqual([
      matrix[0], matrix[1], matrix[2], 0, 0,
      matrix[3], matrix[4], matrix[5], 0, 0,
      matrix[6], matrix[7], matrix[8], 0, 0,
      0, 0, 0, 1, 0,
    ]);
  });
});

describe("FX-2 color assist panel contract", () => {
  it("opens a selected assist at 0.5, preserves an adjusted strength, and closes with the stored strength", () => {
    expect(selectColorAssistKind({ kind: "off", strength: 0 }, "protan")).toEqual({ kind: "protan", strength: 0.5 });
    expect(selectColorAssistKind({ kind: "off", strength: 0.8 }, "tritan")).toEqual({ kind: "tritan", strength: 0.8 });
    expect(selectColorAssistKind({ kind: "protan", strength: 0.4 }, "off")).toEqual({ kind: "off", strength: 0.4 });
  });

  it("renders controlled options, strength and same-screen preview without a page filter or canvas", () => {
    const html = renderToStaticMarkup(createElement(ColorAssistPanel, {
      value: { kind: "deutan", strength: 0.5 },
      onChange: () => undefined,
    }));
    expect(html).toContain("关闭");
    expect(html).toContain("红色弱／红色盲辅助");
    expect(html).toContain("绿色弱／绿色盲辅助");
    expect(html).toContain("蓝色弱／蓝色盲辅助");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("50%");
    expect(html).toContain("原色");
    expect(html).toContain("辅助后");
    expect(html).not.toContain("<canvas");
    expect(html).not.toContain("filter:");
  });
});
