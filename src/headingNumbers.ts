// Heading numbering (`kenMarkdown.headingNumbers.*`). Pure: no `vscode` or DOM
// imports, so the extension host and the webview share it and vitest covers it.
//
// Numbers are display only (webview/markdown/headingNumbers.ts draws them as
// decorations); nothing here ever reaches the Markdown file.
//
// Each level H1–H6 has a style (`decimal` 1, `decimal-leading-zero` 01,
// `lower-alpha` a, `parenthesized-lower-alpha` (a), `lower-alpha-paren` a), …,
// or `none`), a parents mode and a prefix. The counting rules, for the levels
// of a document's top-level headings in order:
//
//   - A numbered heading increments its own level's counter and resets every
//     deeper counter to 0.
//   - Its label is its prefix ("Article ", "Section "; never repeated in
//     deeper labels), then, by its parents mode:
//       full   the counters of every level down to its own, in their own
//              styles, joined by the separator ("1.a.i"); no separator goes
//              before a parenthesized part ("1.01(a)");
//       legal  the same path with every ancestor as plain digits, as Word's
//              "legal style numbering" does ("Section 1.01" under "Article I");
//       own    only its own counter ("(a)");
//       auto   `own` for a parenthesized style, `full` otherwise.
//   - A path leaves out every level whose counter is 0 (a skipped level: H2
//     then H4 gives "1.a.1", not "1.a.0.1") and every level set to `none`.
//   - A heading whose level is `none` gets no label and its counter does not
//     count, but it still resets every deeper counter: with H1 set to `none`,
//     the H2s under each H1 start again at 1.
//   - Letters run a…z, then aa, ab…; roman numerals cover 1–3999 and fall back
//     to decimal beyond, as CSS's own roman counter styles do.

/** The five counters every other style is built from. */
type BaseStyle = "decimal" | "lower-alpha" | "upper-alpha" | "lower-roman" | "upper-roman";

const BASE_STYLES: readonly BaseStyle[] = ["decimal", "lower-alpha", "upper-alpha", "lower-roman", "upper-roman"];

export type HeadingNumberStyle =
  | BaseStyle
  | "decimal-leading-zero"
  | `parenthesized-${BaseStyle}`
  | `${BaseStyle}-paren`
  | "none";

/** Every style, in the order the Settings UI and the dialog list them. */
export const HEADING_NUMBER_STYLES: readonly HeadingNumberStyle[] = [
  "decimal",
  "decimal-leading-zero",
  "lower-alpha",
  "upper-alpha",
  "lower-roman",
  "upper-roman",
  ...BASE_STYLES.map((s) => `parenthesized-${s}` as const),
  ...BASE_STYLES.map((s) => `${s}-paren` as const),
  "none",
];

/** How much of the path to its level a heading's label shows (see the top of this file). */
export type HeadingNumberParents = "auto" | "full" | "legal" | "own";

export const HEADING_NUMBER_PARENTS: readonly HeadingNumberParents[] = ["auto", "full", "legal", "own"];

/** Everything about the numbers but whether they're on. */
export interface NumberingLevels {
  /** One per level, H1 first; always six. */
  styles: HeadingNumberStyle[];
  /** One per level; always six. */
  parents: HeadingNumberParents[];
  /** Text before each level's own label ("Article "); always six. */
  prefixes: string[];
  /** Between the parts of a path ("1.a"). */
  separator: string;
}

export interface HeadingNumbersConfig extends NumberingLevels {
  enabled: boolean;
}

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

const six = <T>(value: T): T[] => Array.from({ length: 6 }, () => value);

// --- Presets --------------------------------------------------------------------

export type HeadingNumberPreset = "outline" | "decimal" | "legal" | "legal-article";

export const HEADING_NUMBER_PRESETS: Readonly<Record<HeadingNumberPreset, Readonly<NumberingLevels>>> = {
  /** 1, 1.a, 1.a.i, 1.a.i.1… (the default). */
  outline: { styles: [...DEFAULT_HEADING_NUMBER_STYLES], parents: six("auto"), prefixes: six(""), separator: "." },
  /** 1, 1.1, 1.1.1… (ISO 2145, legal decimal numbering). */
  decimal: { styles: six("decimal"), parents: six("auto"), prefixes: six(""), separator: "." },
  /** 1, 1.1, 1.1.1, then (a), (i), (A): standard contracts. */
  legal: {
    styles: ["decimal", "decimal", "decimal", "parenthesized-lower-alpha", "parenthesized-lower-roman", "parenthesized-upper-alpha"],
    parents: six("auto"),
    prefixes: six(""),
    separator: ".",
  },
  /** Article I, Section 1.01, (a), (i), (A), (1): US agreements. */
  "legal-article": {
    styles: [
      "upper-roman",
      "decimal-leading-zero",
      "parenthesized-lower-alpha",
      "parenthesized-lower-roman",
      "parenthesized-upper-alpha",
      "parenthesized-decimal",
    ],
    parents: ["auto", "legal", "auto", "auto", "auto", "auto"],
    prefixes: ["Article ", "Section ", "", "", "", ""],
    separator: ".",
  },
};

export const HEADING_NUMBER_PRESET_NAMES = Object.keys(HEADING_NUMBER_PRESETS) as HeadingNumberPreset[];

const isPreset = (value: unknown): value is HeadingNumberPreset =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(HEADING_NUMBER_PRESETS, value);

const copyLevels = (l: Readonly<NumberingLevels>): NumberingLevels => ({
  styles: [...l.styles],
  parents: [...l.parents],
  prefixes: [...l.prefixes],
  separator: l.separator,
});

/**
 * Whether two sets of levels number alike: a parents mode counts as what it
 * resolves to (`auto` on a plain style is `full`), and H1's not at all (it has
 * no parents).
 */
export function sameLevels(a: NumberingLevels, b: NumberingLevels): boolean {
  return (
    a.separator === b.separator &&
    a.styles.every((s, i) => s === b.styles[i]) &&
    a.styles.every(
      (s, i) => i === 0 || resolvedParents(a.parents[i] ?? "auto", s) === resolvedParents(b.parents[i] ?? "auto", b.styles[i] ?? s),
    ) &&
    a.prefixes.every((p, i) => p === b.prefixes[i])
  );
}

/** The preset these levels are, or `custom`. */
export function presetOf(levels: NumberingLevels): HeadingNumberPreset | "custom" {
  return HEADING_NUMBER_PRESET_NAMES.find((name) => sameLevels(levels, HEADING_NUMBER_PRESETS[name])) ?? "custom";
}

export function presetLevels(name: HeadingNumberPreset): NumberingLevels {
  return copyLevels(HEADING_NUMBER_PRESETS[name]);
}

// --- Settings --------------------------------------------------------------------

const isStyle = (value: unknown): value is HeadingNumberStyle =>
  typeof value === "string" && (HEADING_NUMBER_STYLES as readonly string[]).includes(value);
const isParents = (value: unknown): value is HeadingNumberParents =>
  typeof value === "string" && (HEADING_NUMBER_PARENTS as readonly string[]).includes(value);

/**
 * A config from untrusted settings values: anything invalid takes its default.
 * A `preset` other than `custom` replaces every per-level value and the separator.
 */
export function headingNumbersConfig(raw: unknown): HeadingNumbersConfig {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const enabled = value.enabled === true;
  if (isPreset(value.preset)) return { enabled, ...presetLevels(value.preset) };
  const list = (key: string) => (Array.isArray(value[key]) ? (value[key] as unknown[]) : []);
  const styles = list("styles");
  const parents = list("parents");
  const prefixes = list("prefixes");
  return {
    enabled,
    styles: DEFAULT_HEADING_NUMBER_STYLES.map((fallback, i) => (isStyle(styles[i]) ? styles[i] : fallback)),
    parents: six(0).map((_, i) => (isParents(parents[i]) ? parents[i] : "auto")),
    prefixes: six(0).map((_, i) => (typeof prefixes[i] === "string" ? (prefixes[i] as string).replace(/[\r\n]+/g, " ") : "")),
    separator: typeof value.separator === "string" ? value.separator : DEFAULT_HEADING_NUMBER_SEPARATOR,
  };
}

// --- Labels ------------------------------------------------------------------------

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

function base(n: number, style: BaseStyle): string {
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
  }
}

const isParenthesized = (style: HeadingNumberStyle) => style.startsWith("parenthesized-");

/** One counter (1 or more) in a style. */
export function formatCounter(n: number, style: HeadingNumberStyle): string {
  if (style === "none") return "";
  if (style === "decimal-leading-zero") return n < 10 ? `0${n}` : String(n);
  if (isParenthesized(style)) return `(${base(n, style.slice("parenthesized-".length) as BaseStyle)})`;
  if (style.endsWith("-paren")) return `${base(n, style.slice(0, -"-paren".length) as BaseStyle)})`;
  return base(n, style as BaseStyle);
}

/** The parents mode a level actually uses (`auto` resolved). */
export function resolvedParents(parents: HeadingNumberParents, style: HeadingNumberStyle): Exclude<HeadingNumberParents, "auto"> {
  if (parents !== "auto") return parents;
  return isParenthesized(style) ? "own" : "full";
}

/** Path parts joined by the separator, except before a parenthesized part ("1.01(a)"). */
function joinParts(parts: string[], separator: string): string {
  return parts.reduce((out, part, i) => (i === 0 ? part : out + (part.startsWith("(") ? "" : separator) + part), "");
}

/**
 * The label of each heading, given their levels (1–6) in document order, or
 * `null` for one that is not numbered. See the rules at the top of this file.
 */
export function headingNumberLabels(levels: readonly number[], config: HeadingNumbersConfig): (string | null)[] {
  if (!config.enabled) return levels.map(() => null);
  const counters = [0, 0, 0, 0, 0, 0];
  const styleAt = (i: number) => config.styles[i] ?? "none";
  return levels.map((raw) => {
    const level = Math.min(6, Math.max(1, Math.round(raw) || 1));
    const index = level - 1;
    for (let i = index + 1; i < 6; i++) counters[i] = 0;
    const style = styleAt(index);
    if (style === "none") return null;
    counters[index]! += 1;
    const own = formatCounter(counters[index]!, style);
    const mode = resolvedParents(config.parents?.[index] ?? "auto", style);
    const parts: string[] = [];
    if (mode !== "own") {
      for (let i = 0; i < index; i++) {
        const s = styleAt(i);
        if (s === "none" || counters[i]! === 0) continue;
        parts.push(mode === "legal" ? String(counters[i]) : formatCounter(counters[i]!, s));
      }
    }
    parts.push(own);
    return (config.prefixes?.[index] ?? "") + joinParts(parts, config.separator);
  });
}

// --- The document's own setting ------------------------------------------------
//
// A frontmatter property overrides the settings for one document. It is one
// flat scalar, so the Properties panel keeps showing it as a row:
//
//   ken-heading-numbering: off            numbering off, whatever the settings say
//   ken-heading-numbering: on             on, with the settings' levels
//   ken-heading-numbering: legal          on, with a preset: outline, decimal,
//                                         legal or legal-article
//   ken-heading-numbering: "1.a.i"        on, with a format string
//
// `true`/`false` work as `on`/`off`. A format string is one token per level,
// from H1 down, with the same separator between every two:
//
//   format  := level (separator level){0,5}
//   level   := ["[" prefix "]"] style [mode]
//   style   := 1 | a | A | i | I          decimal, lower/upper alpha, lower/upper roman
//            | 01                         decimal with a leading zero
//            | "(" base ")"               parenthesized: (1) (a) (A) (i) (I)
//            | base ")"                   right paren: 1) a) A) i) I)
//            | _                          none
//   mode    := + (full) | # (legal) | ! (own); none given is auto
//   prefix  := any text but "]"; shown before this level's own label only
//
// The separator is the text between the first two levels and can't contain
// 0 1 a A i I _ ( ) [ ] + # !. Levels a string leaves out come from the
// settings (and, for a one-level string, so does the separator). Examples:
// "1.a.i", "I-1-a", "1.1.1.(a).(i).(A)", "[Article ]I.[Section ]01#.(a).(i)".
// Anything else is ignored (the settings apply) and the Properties panel
// flags it.

export const HEADING_NUMBERING_PROPERTY = "ken-heading-numbering";

const BASE_TOKENS: Readonly<Record<string, BaseStyle>> = { "1": "decimal", a: "lower-alpha", A: "upper-alpha", i: "lower-roman", I: "upper-roman" };
const BASE_TOKEN_OF = Object.fromEntries(Object.entries(BASE_TOKENS).map(([t, s]) => [s, t])) as Record<BaseStyle, string>;
const MODE_TOKENS: Readonly<Record<string, HeadingNumberParents>> = { "+": "full", "#": "legal", "!": "own" };
const MODE_TOKEN_OF: Readonly<Record<HeadingNumberParents, string>> = { auto: "", full: "+", legal: "#", own: "!" };
/** Characters a separator can't contain: they start or end a level. */
const RESERVED = "01aAiI_()[]+#!";
/** Characters a level can start with. */
const LEVEL_START = "[(01aAiI_";

/** The format-string token for a style. */
export function styleToken(style: HeadingNumberStyle): string {
  if (style === "none") return "_";
  if (style === "decimal-leading-zero") return "01";
  if (isParenthesized(style)) return `(${BASE_TOKEN_OF[style.slice("parenthesized-".length) as BaseStyle]})`;
  if (style.endsWith("-paren")) return `${BASE_TOKEN_OF[style.slice(0, -"-paren".length) as BaseStyle]})`;
  return BASE_TOKEN_OF[style as BaseStyle];
}

interface FormatLevel {
  style: HeadingNumberStyle;
  parents: HeadingNumberParents;
  prefix: string;
}

/** One level at `at`, and where it ends; null when there isn't one. */
function readLevel(s: string, at: number): (FormatLevel & { end: number }) | null {
  let i = at;
  let prefix = "";
  if (s[i] === "[") {
    const close = s.indexOf("]", i + 1);
    if (close < 0) return null;
    prefix = s.slice(i + 1, close);
    i = close + 1;
  }
  let style: HeadingNumberStyle;
  if (s.startsWith("01", i)) {
    style = "decimal-leading-zero";
    i += 2;
  } else if (s[i] === "(") {
    const b = BASE_TOKENS[s[i + 1] ?? ""];
    if (!b || s[i + 2] !== ")") return null;
    style = `parenthesized-${b}`;
    i += 3;
  } else if (s[i] === "_") {
    style = "none";
    i += 1;
  } else {
    const b = BASE_TOKENS[s[i] ?? ""];
    if (!b) return null;
    i += 1;
    if (s[i] === ")") {
      style = `${b}-paren`;
      i += 1;
    } else style = b;
  }
  const parents = MODE_TOKENS[s[i] ?? ""] ?? "auto";
  if (parents !== "auto") i += 1;
  return { style, parents, prefix, end: i };
}

/** What a document's property says. */
export type NumberingOverride =
  | { enabled: false }
  /** The arrays may be shorter than six; `separator` absent means the settings'. */
  | { enabled: true; styles: HeadingNumberStyle[]; parents: HeadingNumberParents[]; prefixes: string[]; separator?: string };

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

/** A format string (see above) as levels; null when it isn't one. */
function parseFormat(value: string): Extract<NumberingOverride, { enabled: true }> | null {
  const levels: FormatLevel[] = [];
  const first = readLevel(value, 0);
  if (!first) return null;
  levels.push(first);
  let i = first.end;
  let separator: string | undefined;
  if (i < value.length) {
    let j = i;
    while (j < value.length && !LEVEL_START.includes(value[j]!)) j++;
    separator = value.slice(i, j);
    if ([...separator].some((c) => RESERVED.includes(c))) return null;
    i = j;
    while (true) {
      const level = readLevel(value, i);
      if (!level) return null;
      levels.push(level);
      i = level.end;
      if (i === value.length) break;
      if (!value.startsWith(separator, i)) return null;
      i += separator.length;
      // A trailing separator.
      if (i === value.length) return null;
    }
  }
  if (levels.length > 6) return null;
  return {
    enabled: true,
    styles: levels.map((l) => l.style),
    parents: levels.map((l) => l.parents),
    prefixes: levels.map((l) => l.prefix),
    ...(separator === undefined ? {} : { separator }),
  };
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
  if (/^(?:on|true)$/i.test(value)) return { enabled: true, styles: [], parents: [], prefixes: [] };
  if (isPreset(value)) return { enabled: true, ...presetLevels(value) };
  return parseFormat(value);
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
  // A level the property gives is all its own; the rest are the settings'.
  const given = (i: number) => i < override.styles.length;
  return {
    config: {
      enabled: true,
      styles: settings.styles.map((s, i) => (given(i) ? override.styles[i]! : s)),
      parents: settings.parents.map((p, i) => (given(i) ? override.parents[i]! : p)),
      prefixes: settings.prefixes.map((p, i) => (given(i) ? override.prefixes[i]! : p)),
      separator: override.separator ?? settings.separator,
    },
    invalid: false,
  };
}

/** What the "Heading numbering" dialog edits. */
export type NumberingChoice = { mode: "settings" } | { mode: "off" } | ({ mode: "on" } & NumberingLevels);

/** The dialog's starting state for a document's property. */
export function numberingChoice(raw: string | undefined, settings: HeadingNumbersConfig): { choice: NumberingChoice; invalid: boolean } {
  const override = raw === undefined ? undefined : parseNumberingProperty(raw);
  if (override === undefined) return { choice: { mode: "settings" }, invalid: false };
  if (override === null) return { choice: { mode: "settings" }, invalid: true };
  if (!override.enabled) return { choice: { mode: "off" }, invalid: false };
  const { config } = effectiveHeadingNumbers(settings, raw);
  return { choice: { mode: "on", ...copyLevels(config) }, invalid: false };
}

/** Why a separator can't go in the format string, or null. */
export function separatorProblem(separator: string): string | null {
  if (/[\r\n]/.test(separator)) return "The separator must be on one line";
  if ([...separator].some((c) => RESERVED.includes(c))) return `The separator can't contain ${[...RESERVED].join(" ")}`;
  return null;
}

/** Why a prefix can't go in the format string, or null. */
export function prefixProblem(prefix: string): string | null {
  if (/[\r\n]/.test(prefix)) return "A prefix must be on one line";
  if (prefix.includes("]")) return "A prefix can't contain ]";
  return null;
}

/**
 * The property value (YAML text) for a choice, in its shortest form: `off`;
 * `on` when the levels are the settings' own; a preset's name; otherwise the
 * format string. Null for "use editor settings" (no property).
 */
export function formatNumberingProperty(choice: NumberingChoice, settings: HeadingNumbersConfig): string | null {
  if (choice.mode === "settings") return null;
  if (choice.mode === "off") return "off";
  if (sameLevels(choice, settings)) return "on";
  const preset = presetOf(choice);
  if (preset !== "custom") return preset;
  const format = choice.styles
    .map((s, i) => {
      const prefix = choice.prefixes[i] ? `[${choice.prefixes[i]}]` : "";
      return prefix + styleToken(s) + MODE_TOKEN_OF[choice.parents[i] ?? "auto"];
    })
    .join(choice.separator);
  return `"${format.replace(/["\\]/g, "\\$&")}"`;
}
