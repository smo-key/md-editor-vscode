/**
 * Math syntax: `$…$` and `$$…$$` in text, `$$` blocks.
 *
 * remark-math reads every pair of dollar signs as math, so "costs $5 and $10"
 * would turn "5 and " into an equation, and it escapes every literal `$` on
 * save. This follows the rules GitHub and Pandoc use instead:
 *
 * - `$…$`: the opening `$` is followed by a non-space, the closing `$` is
 *   preceded by a non-space and not followed by a digit. `\$` is a literal
 *   dollar, inside math and out.
 * - `$$…$$` in a line is math too (GitHub shows it as display math), and
 *   keeps its delimiters.
 * - A `$$` fence on its own line opens a math block (micromark-extension-math).
 *
 * On save a literal `$` is escaped only where it would otherwise start math,
 * so prices round-trip untouched.
 */
import { math as mathSyntax } from "micromark-extension-math";
import { mathFromMarkdown, mathToMarkdown } from "mdast-util-math";
import { markdownLineEnding, markdownLineEndingOrSpace, markdownSpace } from "micromark-util-character";
import type { Code, Construct, Effects, State, TokenizeContext, Token } from "micromark-util-types";

export type MathDelimiter = "$" | "$$";

const DOLLAR = 36;
const BACKSLASH = 92;
const isDigit = (code: Code) => code !== null && code >= 48 && code <= 57;

// --- Parsing -------------------------------------------------------------------

function tokenizeMathText(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  let size = 0;
  let closing = 0;
  let afterSpace = false;
  let sequence: Token;

  const start: State = (code) => {
    effects.enter("mathText");
    effects.enter("mathTextSequence");
    return open(code);
  };

  const open: State = (code) => {
    if (code === DOLLAR) {
      // Three or more: not math.
      if (size === 2) return nok(code);
      effects.consume(code);
      size++;
      return open;
    }
    effects.exit("mathTextSequence");
    if (code === null) return nok(code);
    if (size === 1 && markdownLineEndingOrSpace(code)) return nok(code);
    return between(code);
  };

  const between: State = (code) => {
    if (code === null) return nok(code);
    if (code === DOLLAR) {
      // After a space a single `$` cannot close: it is part of the math.
      if (size === 1 && afterSpace) {
        effects.enter("mathTextData");
        effects.consume(code);
        afterSpace = false;
        return data;
      }
      sequence = effects.enter("mathTextSequence");
      closing = 0;
      return close(code);
    }
    if (markdownLineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      afterSpace = true;
      return between;
    }
    effects.enter("mathTextData");
    return data(code);
  };

  const data: State = (code) => {
    if (code === null || code === DOLLAR || markdownLineEnding(code)) {
      effects.exit("mathTextData");
      return between(code);
    }
    effects.consume(code);
    if (code === BACKSLASH) {
      afterSpace = false;
      return escaped;
    }
    afterSpace = markdownSpace(code);
    return data;
  };

  // The character after a backslash never closes the math.
  const escaped: State = (code) => {
    if (code === null || markdownLineEnding(code)) return data(code);
    effects.consume(code);
    return data;
  };

  const close: State = (code) => {
    if (code === DOLLAR) {
      effects.consume(code);
      closing++;
      return close;
    }
    if (closing === size && !(size === 1 && isDigit(code))) {
      effects.exit("mathTextSequence");
      effects.exit("mathText");
      return ok(code);
    }
    // Not the closing sequence: those dollars are part of the math.
    sequence.type = "mathTextData";
    afterSpace = false;
    return data(code);
  };

  return start;
}

/** Not straight after another `$` (unless that one was escaped). */
function previous(this: TokenizeContext, code: Code): boolean {
  return code !== DOLLAR || this.events[this.events.length - 1]?.[1].type === "characterEscape";
}

const mathText: Construct = { name: "mathText", tokenize: tokenizeMathText, previous };

/** A `$$` fence line with nothing after the dollars (remark-math takes `$$ text` as a block too). */
const bareFence: Construct = {
  partial: true,
  tokenize(effects, ok, nok) {
    let dollars = 0;
    const start: State = (code) => {
      effects.enter("mathFlowFenceCheck" as never);
      return indent(code);
    };
    const indent: State = (code) => {
      if (markdownSpace(code)) {
        effects.consume(code);
        return indent;
      }
      return sequence(code);
    };
    const sequence: State = (code) => {
      if (code === DOLLAR) {
        effects.consume(code);
        dollars++;
        return sequence;
      }
      return dollars >= 2 ? rest(code) : nok(code);
    };
    const rest: State = (code) => {
      if (markdownSpace(code)) {
        effects.consume(code);
        return rest;
      }
      if (code !== null && !markdownLineEnding(code)) return nok(code);
      effects.exit("mathFlowFenceCheck" as never);
      return ok(code);
    };
    return start;
  },
};

function mathFlowConstruct(): Construct {
  const flow = (mathSyntax().flow as Record<number, Construct>)[DOLLAR]!;
  return {
    ...flow,
    tokenize(effects, ok, nok) {
      return effects.check(bareFence, (code) => flow.tokenize.call(this, effects, ok, nok)(code), nok);
    },
  };
}

/**
 * The first math in `text` at or after `from` (`start` of its opening and
 * `end` after its closing delimiter), by the tokenizer's rules: for escaping
 * on save, where only the string is at hand.
 */
export function matchMath(text: string, from = 0): { start: number; end: number } | null {
  const space = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";
  let escapedBefore = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      escapedBefore = true;
      continue;
    }
    if (c !== "$") {
      escapedBefore = false;
      continue;
    }
    const afterDollar = i > 0 && text[i - 1] === "$" && !escapedBefore;
    escapedBefore = false;
    let run = 1;
    while (text[i + run] === "$") run++;
    if (!afterDollar && run <= 2 && !(run === 1 && (i + 1 >= text.length || space(text[i + 1])))) {
      const end = closing(text, i + run, run);
      if (end >= 0) return { start: i, end };
    }
    i += run - 1;
  }
  return null;

  /** The index after the closing delimiter, or -1. */
  function closing(s: string, j: number, size: number): number {
    let afterSpace = false;
    while (j < s.length) {
      const c = s[j];
      if (c === "\\") {
        j += 2;
        afterSpace = false;
        continue;
      }
      if (c === "$") {
        if (size === 1 && afterSpace) {
          j++;
          afterSpace = false;
          continue;
        }
        let run = 0;
        while (s[j + run] === "$") run++;
        if (run === size && !(size === 1 && /[0-9]/.test(s[j + run] ?? ""))) return j + run;
        j += run;
        afterSpace = false;
        continue;
      }
      afterSpace = space(c);
      j++;
    }
    return -1;
  }
}

/** Escape each `$` in `text` that would open math (given the text that follows it). */
export function escapeMathDollars(text: string, following = ""): string {
  let out = text;
  let from = 0;
  for (;;) {
    const m = matchMath(out + following, from);
    if (!m || m.start >= out.length) return out;
    const run = out[m.start + 1] === "$" ? 2 : 1;
    out = out.slice(0, m.start) + "\\$".repeat(run) + out.slice(m.start + run);
    from = m.start + run * 2;
  }
}

/** How to write inline math so that it reads back as the same math. */
export function inlineMathMarkdown(value: string, delimiter: MathDelimiter, after: string): string {
  if (delimiter === "$") {
    const single = `$${value}$`;
    const m = matchMath(single + after);
    if (m && m.start === 0 && m.end === single.length) return single;
  }
  return `$$${value}$$`;
}

// --- The remark plugin ----------------------------------------------------------

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { delimiter?: MathDelimiter } & Record<string, unknown>;
}

interface FromMarkdownContext {
  stack: MdNode[];
  sliceSerialize(token: Token): string;
}

interface Info {
  before: string;
  after: string;
}

const plainText = (node: MdNode): string =>
  node.value ?? (node.children ?? []).map(plainText).join("");

function remarkMath(this: { data(): Record<string, unknown[] | undefined> }) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push({ flow: { [DOLLAR]: mathFlowConstruct() }, text: { [DOLLAR]: mathText } });

  const from = mathFromMarkdown();
  const exitMathText = from.exit!.mathText!;
  from.exit!.mathText = function (this: FromMarkdownContext, token: Token) {
    const delimiter: MathDelimiter = this.sliceSerialize(token).startsWith("$$") ? "$$" : "$";
    (exitMathText as (this: FromMarkdownContext, token: Token) => void).call(this, token);
    const parent = this.stack[this.stack.length - 1];
    const node = parent?.children?.[parent.children.length - 1];
    if (node?.type === "inlineMath") node.data = { ...node.data, delimiter };
  } as never;
  (data.fromMarkdownExtensions ??= []).push(from);

  const to = mathToMarkdown();
  const inlineMath = (node: MdNode, _parent: unknown, _state: unknown, info: Info) =>
    inlineMathMarkdown(node.value ?? "", node.data?.delimiter ?? "$", info.after);
  inlineMath.peek = () => "$";
  (data.toMarkdownExtensions ??= []).push({
    // remark-math escapes every `$` in text, and `$$` at the start of any
    // line; `withMathEscapes` escapes only what would read back as math.
    unsafe: (to.unsafe ?? []).filter((u) => u.character !== "$" || u.inConstruct === "mathFlowMeta"),
    handlers: { math: to.handlers!.math, inlineMath },
  });

  // A `$$` block becomes a LaTeX code block (edited with CodeMirror, previewed with KaTeX).
  return (tree: MdNode) => {
    const visit = (node: MdNode) => {
      node.children?.forEach((child, i) => {
        if (child.type === "math") node.children![i] = { type: "code", lang: "LaTeX", value: child.value ?? "" } as MdNode;
        else visit(child);
      });
    };
    visit(tree);
  };
}

export { remarkMath };

type TextHandler = (node: MdNode, parent: MdNode | undefined, state: unknown, info: Info) => string;

/**
 * Wraps the stringifier's `text` handler: a literal `$` that would start math
 * when read back is escaped (judged with the text that follows in the same
 * parent); every other `$` is written as is.
 */
export function withMathEscapes(text: TextHandler): TextHandler {
  return (node, parent, state, info) => {
    const out = text(node, parent, state, info);
    if (!out.includes("$")) return out;
    const siblings = parent?.children ?? [];
    const following = siblings.slice(siblings.indexOf(node) + 1).map(plainText).join("") || info.after;
    return escapeBareFences(escapeMathDollars(out, following), !info.before || info.before === "\n", following);
  };
}

/** A line of only `$$` would open a math block: escape it. */
function escapeBareFences(text: string, atLineStart: boolean, following: string): string {
  return text.replace(/(^|\n)([ \t]*)\$\$([ \t]*)(?=\r?\n|$)/g, (line, eol: string, indent: string, trail: string, at: number) => {
    if (at === 0 && !eol && !atLineStart) return line;
    // Ends this text: bare only if the line ends there too.
    if (at + line.length === text.length && following && !/^\r?\n/.test(following)) return line;
    return `${eol}${indent}\\$$${trail}`;
  });
}
