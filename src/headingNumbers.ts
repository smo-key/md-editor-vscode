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

// --- The document's own setting ------------------------------------------------
//
// A frontmatter property overrides the settings for one document. It is a flat
// scalar, so the Properties panel keeps showing it as a row:
//
//   ken-heading-numbering: off          numbering off, whatever the settings say
//   ken-heading-numbering: on           on, with the settings' styles
//   ken-heading-numbering: "1.a.i"      on, with these styles: one token per
//                                       level from H1 down (1 a A i I, or _ for
//                                       none) and the text between them as the
//                                       separator; levels left out (and the
//                                       separator, for one level) come from the
//                                       settings
//
// `true`/`false` work as `on`/`off`. Anything else is ignored (the settings
// apply) and the Properties panel flags it.

export const HEADING_NUMBERING_PROPERTY = "ken-heading-numbering";

/** The format-string token for each style. */
export const STYLE_TOKENS: Readonly<Record<HeadingNumberStyle, string>> = {
  decimal: "1",
  "lower-alpha": "a",
  "upper-alpha": "A",
  "lower-roman": "i",
  "upper-roman": "I",
  none: "_",
};

const TOKEN_STYLES = new Map(Object.entries(STYLE_TOKENS).map(([style, token]) => [token, style as HeadingNumberStyle]));

/** What a document's property says. */
export type NumberingOverride =
  | { enabled: false }
  /** `styles` may be shorter than six; `separator` absent means the settings'. */
  | { enabled: true; styles: HeadingNumberStyle[]; separator?: string };

/** A YAML scalar as written after `key:`, unquoted; null when a quote isn't closed. */
function unquote(text: string): string | null {
  const t = text.trim();
  if (t.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"$/.exec(t);
    return m ? m[1]!.replace(/\\(.)/g, "$1") : null;
  }
  if (t.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'$/.exec(t);
    return m ? m[1]!.replace(/''/g, "'") : null;
  }
  return t;
}

/**
 * The property's value (its YAML text, quotes included) as an override;
 * `undefined` when it is empty or null (no override); `null` when invalid.
 */
export function parseNumberingProperty(raw: string): NumberingOverride | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "" || /^(?:~|null)$/i.test(trimmed)) return undefined;
  const value = unquote(trimmed);
  if (value === null) return null;
  if (/^(?:off|false)$/i.test(value)) return { enabled: false };
  if (/^(?:on|true)$/i.test(value)) return { enabled: true, styles: [] };
  const first = TOKEN_STYLES.get(value[0] ?? "");
  if (!first) return null;
  const styles = [first];
  let i = 1;
  let j = i;
  while (j < value.length && !TOKEN_STYLES.has(value[j]!)) j++;
  if (j === value.length && j === 1) return { enabled: true, styles };
  const separator = value.slice(i, j);
  i = j;
  while (i < value.length) {
    const style = TOKEN_STYLES.get(value[i]!);
    if (!style) return null;
    styles.push(style);
    i += 1;
    if (i === value.length) break;
    if (!value.startsWith(separator, i)) return null;
    i += separator.length;
    // A trailing separator, or a token where the separator should be.
    if (i === value.length || (separator === "" && !TOKEN_STYLES.has(value[i]!))) return null;
  }
  if (styles.length > 6 || styles.length < 2) return null;
  return { enabled: true, styles, separator };
}

/** The config for a document: its property (raw YAML text) over the settings. */
export function effectiveHeadingNumbers(
  settings: HeadingNumbersConfig,
  raw: string | undefined,
): { config: HeadingNumbersConfig; invalid: boolean } {
  if (raw === undefined) return { config: settings, invalid: false };
  const override = parseNumberingProperty(raw);
  if (override === undefined) return { config: settings, invalid: false };
  if (override === null) return { config: settings, invalid: true };
  if (!override.enabled) return { config: { ...settings, enabled: false }, invalid: false };
  return {
    config: {
      enabled: true,
      styles: settings.styles.map((s, i) => override.styles[i] ?? s),
      separator: override.separator ?? settings.separator,
    },
    invalid: false,
  };
}

/** What the "Heading numbering" dialog edits. */
export type NumberingChoice =
  | { mode: "settings" }
  | { mode: "off" }
  | { mode: "on"; styles: HeadingNumberStyle[]; separator: string };

/** The dialog's starting state for a document's property. */
export function numberingChoice(raw: string | undefined, settings: HeadingNumbersConfig): { choice: NumberingChoice; invalid: boolean } {
  const override = raw === undefined ? undefined : parseNumberingProperty(raw);
  if (override === undefined) return { choice: { mode: "settings" }, invalid: false };
  if (override === null) return { choice: { mode: "settings" }, invalid: true };
  if (!override.enabled) return { choice: { mode: "off" }, invalid: false };
  const { config } = effectiveHeadingNumbers(settings, raw);
  return { choice: { mode: "on", styles: config.styles, separator: config.separator }, invalid: false };
}

/** Why a separator can't go in the format string, or null. */
export function separatorProblem(separator: string): string | null {
  if (/[\r\n]/.test(separator)) return "The separator must be on one line";
  const token = [...separator].find((c) => TOKEN_STYLES.has(c));
  if (token) return `The separator can't contain ${Object.values(STYLE_TOKENS).join(" ")}`;
  return null;
}

/**
 * The property value (YAML text) for a choice, in its compact form: `off`,
 * `on` when the styles are the settings' own, otherwise the format string;
 * null for "use editor settings" (no property).
 */
export function formatNumberingProperty(choice: NumberingChoice, settings: HeadingNumbersConfig): string | null {
  if (choice.mode === "settings") return null;
  if (choice.mode === "off") return "off";
  const same = choice.separator === settings.separator && choice.styles.every((s, i) => s === settings.styles[i]);
  if (same) return "on";
  const format = choice.styles.map((s) => STYLE_TOKENS[s]).join(choice.separator);
  return `"${format.replace(/["\\]/g, "\\$&")}"`;
}
