// Heading numbering (`kenMarkdown.headingNumbers.*`). Pure: no `vscode` or DOM
// imports, so the extension host and the webview share it and vitest covers it.
//
// Numbers are display only (webview/markdown/headingNumbers.ts draws them as
// decorations); nothing here ever reaches the Markdown file.
//
// The counting rules, for the levels of a document's top-level headings in
// order:
//
//   - A numbered heading increments its own level's counter and resets every
//     deeper counter to 0.
//   - Its label joins the counters of levels 1 through its own, with the
//     separator, leaving out every level whose counter is 0 (a skipped level:
//     H2 then H4 gives "1.a.1", not "1.a.0.1") and every level set to `none`.
//   - A heading whose level is `none` gets no label and its counter does not
//     count, but it still resets every deeper counter: with H1 set to `none`,
//     the H2s under each H1 start again at 1.
//   - Letters run a…z, then aa, ab…; roman numerals cover 1–3999 and fall back
//     to decimal beyond, as CSS's own roman counter styles do.

export type HeadingNumberStyle = "decimal" | "lower-alpha" | "upper-alpha" | "lower-roman" | "upper-roman" | "none";

export const HEADING_NUMBER_STYLES: readonly HeadingNumberStyle[] = [
  "decimal",
  "lower-alpha",
  "upper-alpha",
  "lower-roman",
  "upper-roman",
  "none",
];

/** Styles for H1–H6 by default: "1", "1.a", "1.a.i", "1.a.i.1"… */
export const DEFAULT_HEADING_NUMBER_STYLES: readonly HeadingNumberStyle[] = [
  "decimal",
  "lower-alpha",
  "lower-roman",
  "decimal",
  "lower-alpha",
  "lower-roman",
];

export const DEFAULT_HEADING_NUMBER_SEPARATOR = ".";

export interface HeadingNumbersConfig {
  enabled: boolean;
  /** One style per level, H1 first; always six. */
  styles: HeadingNumberStyle[];
  /** Between the levels of a label ("1.a"). */
  separator: string;
}

const isStyle = (value: unknown): value is HeadingNumberStyle =>
  typeof value === "string" && (HEADING_NUMBER_STYLES as readonly string[]).includes(value);

/** A config from untrusted settings values: anything invalid takes its default. */
export function headingNumbersConfig(raw: unknown): HeadingNumbersConfig {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const styles = Array.isArray(value.styles) ? value.styles : [];
  return {
    enabled: value.enabled === true,
    styles: DEFAULT_HEADING_NUMBER_STYLES.map((fallback, i) => (isStyle(styles[i]) ? styles[i] : fallback)),
    separator: typeof value.separator === "string" ? value.separator : DEFAULT_HEADING_NUMBER_SEPARATOR,
  };
}

/** Bijective base 26: 1 → a, 26 → z, 27 → aa. */
function alpha(n: number): string {
  let out = "";
  for (let rest = n; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    out = String.fromCharCode(97 + ((rest - 1) % 26)) + out;
  }
  return out;
}

const ROMAN: readonly [number, string][] = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

function roman(n: number): string {
  if (n > 3999) return String(n);
  let out = "";
  let rest = n;
  for (const [value, digits] of ROMAN) {
    for (; rest >= value; rest -= value) out += digits;
  }
  return out;
}

/** One counter (1 or more) in a style. */
export function formatCounter(n: number, style: HeadingNumberStyle): string {
  switch (style) {
    case "decimal":
      return String(n);
    case "lower-alpha":
      return alpha(n);
    case "upper-alpha":
      return alpha(n).toUpperCase();
    case "lower-roman":
      return roman(n);
    case "upper-roman":
      return roman(n).toUpperCase();
    case "none":
      return "";
  }
}

/**
 * The label of each heading, given their levels (1–6) in document order, or
 * `null` for one that is not numbered. See the rules at the top of this file.
 */
export function headingNumberLabels(levels: readonly number[], config: HeadingNumbersConfig): (string | null)[] {
  if (!config.enabled) return levels.map(() => null);
  const counters = [0, 0, 0, 0, 0, 0];
  return levels.map((raw) => {
    const level = Math.min(6, Math.max(1, Math.round(raw) || 1));
    const index = level - 1;
    for (let i = index + 1; i < 6; i++) counters[i] = 0;
    const style = config.styles[index] ?? "none";
    if (style === "none") return null;
    counters[index]! += 1;
    const parts: string[] = [];
    for (let i = 0; i <= index; i++) {
      const s = config.styles[i] ?? "none";
      if (s !== "none" && counters[i]! > 0) parts.push(formatCounter(counters[i]!, s));
    }
    return parts.join(config.separator);
  });
}
