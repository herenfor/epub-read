import { describe, expect, it } from "vitest";

// Every stylesheet and source file as text, so the shared tokens stay the only source of radii and colours.
// Vitest blanks CSS imports (even ?raw), so the glob only lists the paths and the files are read from disk.
const fs: { readFileSync(path: URL, encoding: "utf8"): string } = await import("node:" + "fs");
const read = (paths: Record<string, unknown>) =>
  Object.fromEntries(Object.keys(paths).map((path) => [path, fs.readFileSync(new URL(path, import.meta.url), "utf8")]));
const styles = read(import.meta.glob("../**/*.css"));
const sources = read(import.meta.glob(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}"]));

/** Known literals still to move onto the tokens (ER-0041); this list only shrinks. */
const RADIUS_EXCEPTIONS = new Set(["../features/ai/ui/ai.css", "../features/ai/companion/companion.css"]);
/** Set where this scan cannot see it: inside the book's iframe, or reserved for a reading font. */
const RUNTIME_VARIABLES = new Set(["--font-reading", "--reader-fill-height"]);

function radiusLiterals(css: string): string[] {
  const found: string[] = [];
  for (const match of css.matchAll(/border(?:-[a-z]+)*-radius\s*:\s*([^;}]+)/g)) {
    const rest = match[1]
      .replace(/!important/g, "")
      // A nested radius derived from its outer one: calc(var(--r-sm) - 2px), or from variables.
      .replace(/calc\(\s*var\(--[\w-]+\)\s*-\s*(?:var\(--[\w-]+\)|\d+(?:\.\d+)?px)\s*\)/g, "")
      .replace(/var\(--[\w-]+\)/g, "")
      .trim();
    for (const token of rest.split(/\s+/).filter(Boolean)) {
      if (!/^(?:0|50%|1px|inherit|unset|\/)$/.test(token)) found.push(match[0].trim());
    }
  }
  return found;
}

describe("design tokens", () => {
  it("reads the whole app", () => {
    expect(Object.keys(styles).length).toBeGreaterThan(30);
    expect(styles["../styles.css"]).toContain("border-radius");
    expect(Object.keys(sources).length).toBeGreaterThan(100);
  });

  it("takes every radius from the radius tokens", () => {
    const literals = Object.entries(styles)
      .filter(([path]) => !RADIUS_EXCEPTIONS.has(path))
      .flatMap(([path, css]) => radiusLiterals(css).map((rule) => `${path}: ${rule}`));
    const inline = Object.entries(sources)
      .flatMap(([path, code]) => [...code.matchAll(/borderRadius\s*:\s*["'`]?\d/g)].map(() => `${path}: inline borderRadius`));
    expect([...literals, ...inline]).toEqual([]);
  });

  it("only reads variables that something defines", () => {
    const defined = new Set<string>();
    for (const text of [...Object.values(styles), ...Object.values(sources)]) {
      for (const match of text.matchAll(/(--[\w-]+)\s*:/g)) defined.add(match[1]);
      for (const match of text.matchAll(/["'`](--[\w-]+)["'`]/g)) defined.add(match[1]);
    }
    const missing = new Set<string>();
    for (const [path, text] of [...Object.entries(styles), ...Object.entries(sources)]) {
      for (const match of text.matchAll(/var\(\s*(--[\w-]+)/g)) {
        if (!defined.has(match[1]) && !RUNTIME_VARIABLES.has(match[1])) missing.add(`${path}: ${match[1]}`);
      }
    }
    expect([...missing]).toEqual([]);
  });
});
