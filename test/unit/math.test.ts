import { describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

import { command } from "../../webview/commands";
import { normalizeTrailingNewlines } from "../../webview/markdown/gfmFidelity";
import { escapeMathDollars, inlineMathMarkdown, matchMath } from "../../webview/markdown/mathSyntax";
import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();

type Mounted = Awaited<ReturnType<typeof mountEditor>>;

async function withEditor(markdown: string, fn: (ed: Mounted, view: EditorView, md: () => string) => void | Promise<void>) {
  const ed = await mountEditor(markdown);
  const view = ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
  try {
    await fn(ed, view, () => normalizeTrailingNewlines(ed.markdown()));
  } finally {
    await ed.destroy();
  }
}

/** Formulas in the document, in order. */
function formulas(view: EditorView): { value: string; delimiter: string }[] {
  const out: { value: string; delimiter: string }[] = [];
  view.state.doc.descendants((node) => {
    if (node.type.name === "math_inline") out.push({ value: node.attrs.value, delimiter: node.attrs.delimiter });
  });
  return out;
}

function mathBlocks(view: EditorView): string[] {
  const out: string[] = [];
  view.state.doc.descendants((node) => {
    if (node.type.name === "code_block" && /^(latex|math)$/i.test(node.attrs.language)) out.push(node.textContent);
  });
  return out;
}

/** Type like a user: input rules run. */
function type(view: EditorView, text: string) {
  for (const ch of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)));
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
  }
}

function caretAtEndOf(view: EditorView, text: string) {
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text!.includes(text)) at = pos + node.text!.indexOf(text) + text.length;
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
}

describe("math syntax", () => {
  it.each([
    ["$x$", { start: 0, end: 3 }],
    ["a $x^2 + y$ b", { start: 2, end: 11 }],
    ["$$\\sum$$", { start: 0, end: 8 }],
    ["$\\$5$", { start: 0, end: 5 }],
    ["$5 for x$", { start: 0, end: 9 }],
  ])("finds math in %j", (text, span) => {
    expect(matchMath(text)).toEqual(span);
  });

  it.each([
    "costs $5 and $10",
    "US$5, or $6",
    "$ x$",
    "$x $",
    "$x$5",
    "\\$x\\$",
    "$$$x$$$",
    "a $ b",
  ])("finds no math in %j", (text) => {
    expect(matchMath(text)).toBeNull();
  });

  it("escapes only the dollars that would start math", () => {
    expect(escapeMathDollars("costs $5 and $10")).toBe("costs $5 and $10");
    expect(escapeMathDollars("literal $a$ here")).toBe("literal \\$a$ here");
    expect(escapeMathDollars("$$x$$")).toBe("\\$\\$x$$");
    // A closing dollar in a later sibling (e.g. after emphasis) counts.
    expect(escapeMathDollars("a $b ", "c$ d")).toBe("a \\$b ");
  });

  it("writes inline math with the delimiter it had, or $$ when $ would not read back", () => {
    expect(inlineMathMarkdown("x^2", "$", " ")).toBe("$x^2$");
    expect(inlineMathMarkdown("x^2", "$$", " ")).toBe("$$x^2$$");
    expect(inlineMathMarkdown(" x ", "$", " ")).toBe("$$ x $$");
    expect(inlineMathMarkdown("x", "$", "5")).toBe("$$x$$");
  });
});

describe("math in the editor", () => {
  it.each([
    "Euler: $e^{i\\pi} + 1 = 0$ is neat.\n",
    "It costs $5 and $10 today.\n",
    "Prices: US$5, or $6.\n",
    "Display $$\\sum_i x_i$$ inline.\n",
    "$$x^2$$\n",
    "$$\n\\int_0^1 x\\,dx\n$$\n",
    "```math\na^2+b^2=c^2\n```\n",
    "Escaped $\\$5$ in math.\n",
    "Code `$x$` stays.\n",
    "Line $a\nb$ break.\n",
    "$$ not a block\n",
    "x\n\\$$\ny\n",
    "A $x$5 digit.\n",
    "| a | $x_1$ |\n| - | ----- |\n| 1 | 2     |\n",
  ])("round-trips %j unchanged", async (markdown) => {
    await withEditor(markdown, (_ed, _view, md) => {
      expect(md()).toBe(markdown);
    });
  });

  it("reads inline and block math, not prices", async () => {
    await withEditor("Pay $5 and $10.\n\nFor $a^2$ and $$b$$.\n\n$$\nc\n$$\n\n```math\nd\n```\n", (_ed, view) => {
      expect(formulas(view)).toEqual([
        { value: "a^2", delimiter: "$" },
        { value: "b", delimiter: "$$" },
      ]);
      expect(mathBlocks(view)).toEqual(["c", "d"]);
    });
  });

  // KaTeX itself needs a standards-mode document, which happy-dom is not
  // (harness/check-editing.mjs checks the rendering in Chromium).
  it("shows formulas through their own view", async () => {
    await withEditor("Euler $e^{i\\pi}$.\n", async (ed) => {
      const el = ed.root.querySelector<HTMLElement>(".ken-math")!;
      expect(el.dataset.value).toBe("e^{i\\pi}");
      await expect.poll(() => el.querySelector(".ken-math-render")?.textContent).toBeTruthy();
    });
  });

  it("escapes a literal $…$ on save, and leaves prices alone", async () => {
    await withEditor("Price $5 and $10.\n\nNote\n", (_ed, view, md) => {
      caretAtEndOf(view, "Note");
      // Inserted as text (not typed), so no input rule turns it into math.
      view.dispatch(view.state.tr.insertText(" $a$"));
      expect(md()).toBe("Price $5 and $10.\n\nNote \\$a$\n");
      expect(formulas(view)).toEqual([]);
    });
  });

  it("turns typed $…$ into math, but not prices", async () => {
    await withEditor("Text\n", (_ed, view, md) => {
      caretAtEndOf(view, "Text");
      type(view, " costs $5 and $");
      expect(formulas(view)).toEqual([]);
      type(view, "10, and $x^2$");
      expect(formulas(view)).toEqual([{ value: "x^2", delimiter: "$" }]);
      type(view, " ok");
      expect(md()).toBe("Text costs $5 and $10, and $x^2$ ok\n");
      // Not across a formula: "$10, and [x^2] ok$" stays text.
      type(view, "$");
      expect(formulas(view)).toEqual([{ value: "x^2", delimiter: "$" }]);
    });
  });

  it("starts a math block on $$ and a space", async () => {
    await withEditor("Intro\n\nx\n", (_ed, view, md) => {
      caretAtEndOf(view, "x");
      view.dispatch(view.state.tr.delete(view.state.selection.from - 1, view.state.selection.from));
      type(view, "$$ ");
      view.dispatch(view.state.tr.insertText("x^2"));
      expect(md()).toBe("Intro\n\n$$\nx^2\n$$\n");
    });
  });

  it("inserts an equation block and inline equations from commands", async () => {
    await withEditor("Intro\n", (ed, view, md) => {
      caretAtEndOf(view, "Intro");
      ed.crepe.editor.action((ctx) => command("math-block").run(ctx, view));
      view.dispatch(view.state.tr.insertText("y = mx + b"));
      expect(md()).toBe("Intro\n\n$$\ny = mx + b\n$$\n");
    });
    await withEditor("Area is pi r^2.\n", (ed, view, md) => {
      caretAtEndOf(view, "Area is ");
      const from = view.state.selection.from;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + 6)));
      ed.crepe.editor.action((ctx) => command("math-inline").run(ctx, view));
      expect(formulas(view)).toEqual([{ value: "pi r^2", delimiter: "$" }]);
      // Its editor opened in place; Escape keeps the formula.
      const input = ed.root.querySelector<HTMLInputElement>(".ken-math-input")!;
      expect(input.value).toBe("pi r^2");
      input.value = "\\pi r^2";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(md()).toBe("Area is $\\pi r^2$.\n");
    });
  });
});
