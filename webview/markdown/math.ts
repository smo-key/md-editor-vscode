/**
 * LaTeX math, rendered with KaTeX (see mathSyntax.ts for the Markdown rules).
 *
 * - Inline math (`$…$`, `$$…$$` within a line) is an atom node showing the
 *   rendered formula; clicking it (or Enter while it is selected) edits the
 *   source in place, with a live preview. Typing `$x^2$` creates one.
 * - Block math (a `$$` block, or a ```` ```math ```` fence as on GitHub) is a
 *   code block previewed with KaTeX: the formula shows, and its source opens
 *   beneath it while the caret is in it. Typing `$$` and a space starts one.
 *
 * KaTeX is loaded the first time a formula is shown.
 */
import type { Ctx } from "@milkdown/kit/ctx";
import { editorViewCtx, remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { codeBlockSchema } from "@milkdown/kit/preset/commonmark";
import { InputRule, textblockTypeInputRule } from "@milkdown/kit/prose/inputrules";
import { keymap } from "@milkdown/kit/prose/keymap";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView, type NodeView } from "@milkdown/kit/prose/view";
import type { CodeBlockConfig } from "@milkdown/kit/component/code-block";
import type { MarkdownNode, ParserState, SerializerState } from "@milkdown/kit/transformer";
import { $inputRule, $nodeSchema, $prose, $remark, $view } from "@milkdown/kit/utils";
import { remarkMath, withMathEscapes, type MathDelimiter } from "./mathSyntax";

type Katex = typeof import("katex").default;
let katexPromise: Promise<Katex> | undefined;
const loadKatex = () => (katexPromise ??= import("katex").then((m) => m.default));

/** Render `tex` into `el` (an error shows as the source, marked). */
async function renderTex(el: HTMLElement, tex: string, displayMode: boolean): Promise<void> {
  const katex = await loadKatex();
  try {
    katex.render(tex, el, { displayMode, throwOnError: true, strict: "ignore", output: "htmlAndMathml" });
    el.removeAttribute("title");
    el.classList.remove("ken-math-error");
  } catch (err) {
    el.textContent = tex;
    el.title = err instanceof Error ? err.message : String(err);
    el.classList.add("ken-math-error");
  }
}

/** Code block languages shown as math. */
export const isMathLanguage = (language: string | null | undefined): boolean =>
  /^(latex|math|tex|katex)$/i.test(language ?? "");

// --- Inline math -----------------------------------------------------------------

export const mathInlineSchema = $nodeSchema("math_inline", () => ({
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  attrs: {
    value: { default: "" },
    delimiter: { default: "$" },
  },
  parseDOM: [
    {
      tag: 'span[data-type="math_inline"]',
      getAttrs: (dom: HTMLElement) => ({
        value: dom.dataset.value ?? "",
        delimiter: dom.dataset.delimiter === "$$" ? "$$" : "$",
      }),
    },
  ],
  // For the clipboard (the editor shows MathView).
  toDOM: (node: ProseNode) => [
    "span",
    { "data-type": "math_inline", "data-value": node.attrs.value, "data-delimiter": node.attrs.delimiter },
    node.attrs.value as string,
  ],
  parseMarkdown: {
    match: (node: MarkdownNode) => node.type === "inlineMath",
    runner: (state: ParserState, node: MarkdownNode, type) => {
      const delimiter = (node.data as { delimiter?: MathDelimiter } | undefined)?.delimiter ?? "$";
      state.addNode(type, { value: (node.value as string) ?? "", delimiter });
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === "math_inline",
    runner: (state: SerializerState, node: ProseNode) => {
      state.addNode("inlineMath", undefined, node.attrs.value as string, { data: { delimiter: node.attrs.delimiter } });
    },
  },
}));

/** Ask the inline math at `pos` to open its editor. */
export function editInlineMath(view: EditorView, pos: number): void {
  view.nodeDOM(pos)?.dispatchEvent(new CustomEvent("ken-math-edit"));
}

class MathView implements NodeView {
  dom: HTMLElement;
  private editing = false;

  constructor(
    private node: ProseNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.dom = document.createElement("span");
    this.dom.dataset.type = "math_inline";
    this.dom.contentEditable = "false";
    this.dom.addEventListener("click", (e) => {
      if (this.editing) return;
      e.preventDefault();
      this.edit();
    });
    this.dom.addEventListener("ken-math-edit", () => this.edit());
    this.render();
  }

  private get value(): string {
    return this.node.attrs.value as string;
  }

  private get display(): boolean {
    return this.node.attrs.delimiter === "$$";
  }

  private render() {
    this.dom.className = "ken-math";
    this.dom.dataset.value = this.value;
    this.dom.dataset.delimiter = this.node.attrs.delimiter as string;
    this.dom.title = "";
    if (!this.value.trim()) {
      this.dom.classList.add("ken-math-empty");
      this.dom.textContent = "Equation";
      return;
    }
    const out = document.createElement("span");
    out.className = "ken-math-render";
    this.dom.replaceChildren(out);
    void renderTex(out, this.value, this.display);
  }

  edit() {
    if (this.editing || !this.view.editable) return;
    this.editing = true;
    const original = this.value;
    const input = document.createElement("input");
    input.className = "ken-math-input";
    input.value = original;
    input.spellcheck = false;
    input.placeholder = "LaTeX, e.g. e^{i\\pi} + 1 = 0";
    input.setAttribute("aria-label", "Equation (LaTeX)");
    input.size = Math.max(8, original.length + 1);
    const preview = document.createElement("span");
    preview.className = "ken-math-preview";
    const showPreview = () => {
      input.size = Math.max(8, input.value.length + 1);
      preview.hidden = !input.value.trim();
      if (!preview.hidden) void renderTex(preview, input.value, false);
    };
    let done = false;
    const finish = (commit: boolean, move: "after" | "before" = "after") => {
      if (done) return;
      done = true;
      this.editing = false;
      const pos = this.getPos();
      if (pos === undefined) return;
      const next = input.value;
      let tr = this.view.state.tr;
      if (commit && next !== original) {
        tr = next.trim()
          ? tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, value: next })
          : tr.delete(pos, pos + this.node.nodeSize);
      }
      if (!(commit && next !== original)) this.render();
      const exists = tr.doc.nodeAt(pos)?.type === this.node.type;
      const at = exists && move === "after" ? pos + this.node.nodeSize : pos;
      tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(at, tr.doc.content.size))));
      this.view.dispatch(tr);
      this.view.focus();
    };
    input.addEventListener("input", showPreview);
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "ArrowLeft" && input.selectionStart === 0 && input.selectionEnd === 0) {
        e.preventDefault();
        finish(true, "before");
      } else if (e.key === "ArrowRight" && input.selectionStart === input.value.length) {
        e.preventDefault();
        finish(true, "after");
      }
    });
    input.addEventListener("blur", () => {
      // Leaving for elsewhere in the editor or the window: keep the edit, leave the caret alone.
      if (done) return;
      done = true;
      this.editing = false;
      const pos = this.getPos();
      const next = input.value;
      if (pos !== undefined && next !== original) {
        this.view.dispatch(
          next.trim()
            ? this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, value: next })
            : this.view.state.tr.delete(pos, pos + this.node.nodeSize),
        );
      } else {
        this.render();
      }
    });
    this.dom.className = "ken-math ken-math-editing";
    this.dom.replaceChildren(input, preview);
    showPreview();
    input.focus();
    input.select();
  }

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    if (this.editing) {
      this.node = node;
      return true;
    }
    const changed = node.attrs.value !== this.node.attrs.value || node.attrs.delimiter !== this.node.attrs.delimiter;
    this.node = node;
    if (changed) this.render();
    return true;
  }

  stopEvent(event: Event): boolean {
    return this.editing && (event.target as Node | null) !== this.dom;
  }

  ignoreMutation(): boolean {
    return true;
  }

  selectNode() {
    this.dom.classList.add("ProseMirror-selectednode");
  }

  deselectNode() {
    this.dom.classList.remove("ProseMirror-selectednode");
  }
}

export const mathInlineView = $view(mathInlineSchema.node, () => (node, view, getPos) => new MathView(node, view, getPos));

/** Insert inline math at the selection (its text becomes the formula) and edit it. */
export function insertInlineMath(ctx: Ctx): void {
  const view = ctx.get(editorViewCtx);
  const { state } = view;
  const { from, to } = state.selection;
  const value = state.doc.textBetween(from, to, " ");
  const node = mathInlineSchema.type(ctx).create({ value });
  const tr = state.tr.replaceSelectionWith(node, false);
  tr.setSelection(NodeSelection.create(tr.doc, from));
  view.dispatch(tr.scrollIntoView());
  editInlineMath(view, from);
}

// --- Typing -------------------------------------------------------------------------

/** Inside code (a code block or inline code) dollars are just dollars. */
function inCode(state: EditorState, pos: number): boolean {
  const $pos = state.doc.resolve(pos);
  if ($pos.parent.type.spec.code) return true;
  return $pos.marks().some((m) => m.type.spec.code || m.type.name === "inlineCode");
}

/**
 * `$x^2$` typed in text becomes math, by the same rules as reading a file:
 * no space just inside either dollar, and not straight after a `$` or `\`.
 * Never across another inline node (U+FFFC in the text before the caret).
 */
export const mathInlineInputRule = $inputRule(
  (ctx) =>
    new InputRule(/(^|[^$\\\ufffc])\$([^\s$\ufffc](?:[^$\ufffc]*?[^\s$\\\ufffc])?)\$$/, (state, match, start, end) => {
      const from = start + match[1]!.length;
      if (inCode(state, from)) return null;
      const node = mathInlineSchema.type(ctx).create({ value: match[2] });
      return state.tr.replaceWith(from, end, node);
    }),
);

/** `$$` and a space at the start of a line opens a math block. */
export const mathBlockInputRule = $inputRule((ctx) =>
  textblockTypeInputRule(/^\$\$\s$/, codeBlockSchema.type(ctx), () => ({ language: "LaTeX" })),
);

/** Enter on selected inline math edits it. */
export const mathKeys = $prose(
  () =>
    keymap({
      Enter: (state, _dispatch, view) => {
        const sel = state.selection;
        if (!(sel instanceof NodeSelection) || sel.node.type.name !== "math_inline" || !view) return false;
        editInlineMath(view, sel.from);
        return true;
      },
    }),
);

// --- Block math ------------------------------------------------------------------------

/** A LaTeX code block is written back as a `$$` block (```math fences stay fences). */
export const mathBlockSchema = codeBlockSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state: SerializerState, node: ProseNode) => {
        if (/^latex$/i.test((node.attrs.language as string) ?? "")) {
          state.addNode("math", undefined, node.content.firstChild?.text ?? "");
        } else {
          base.toMarkdown.runner(state, node);
        }
      },
    },
  };
});

/**
 * Crepe `renderPreview` for math blocks: `null` for other languages, else
 * `undefined` (async) and the formula via `applyPreview`.
 */
export function renderMathPreview(
  language: string,
  content: string,
  applyPreview: (value: null | string | HTMLElement) => void,
): ReturnType<CodeBlockConfig["renderPreview"]> {
  if (!isMathLanguage(language) || !content.trim()) return null;
  const el = document.createElement("div");
  el.className = "ken-math-block";
  void renderTex(el, content, true).then(() => applyPreview(el));
  return undefined;
}

/**
 * Math code blocks are marked on the element (`data-math`, and
 * `data-editing` while the selection is in one), so the stylesheet shows the
 * source only while editing; a click on the formula starts editing. A
 * paragraph of just `$$…$$` is marked too, to centre it.
 */
export const mathBlockPlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey("ken-math-block"),
      props: {
        decorations: (state) => {
          const decorations: Decoration[] = [];
          const { from, to } = state.selection;
          state.doc.descendants((node, pos) => {
            // `$$…$$` alone in a paragraph: a display formula, centred as on GitHub.
            const only = node.type.name === "paragraph" && node.childCount === 1 ? node.firstChild : null;
            if (only?.type.name === "math_inline" && only.attrs.delimiter === "$$") {
              decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "ken-math-display" }));
            }
            if (node.type.name !== "code_block") return !node.isTextblock;
            if (isMathLanguage(node.attrs.language as string)) {
              const editing = from > pos && to < pos + node.nodeSize;
              decorations.push(
                Decoration.node(pos, pos + node.nodeSize, editing ? { "data-math": "", "data-editing": "" } : { "data-math": "" }),
              );
            }
            return false;
          });
          return DecorationSet.create(state.doc, decorations);
        },
      },
      // The code block's view keeps events to itself, so listen on the element.
      view: (view) => {
        const onDown = (event: MouseEvent) => {
          const target = event.target as Element | null;
          const el = target?.closest?.(".milkdown-code-block[data-math]");
          if (!el || event.button !== 0 || el.hasAttribute("data-editing") || !target?.closest(".preview-panel")) return;
          let end = -1;
          view.state.doc.descendants((node, pos) => {
            if (end >= 0) return false;
            if (view.nodeDOM(pos) === el) end = pos + 1 + node.content.size;
            return end < 0 && !node.isTextblock;
          });
          if (end < 0) return;
          event.preventDefault();
          event.stopPropagation();
          // The block's view focuses its CodeMirror when the selection lands in it.
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
          if (!el.contains(document.activeElement)) el.querySelector<HTMLElement>(".cm-content")?.focus();
        };
        view.dom.addEventListener("mousedown", onDown, true);
        return { destroy: () => view.dom.removeEventListener("mousedown", onDown, true) };
      },
    }),
);

export const remarkMathPlugin = $remark("kenMath", () => remarkMath as never);

/** Literal dollars are escaped only where they would read back as math (an editor config). */
export function configureMathText(ctx: Ctx): void {
  ctx.update(remarkStringifyOptionsCtx, (opts) => {
    const handlers = (opts.handlers ?? {}) as Record<string, unknown>;
    const text = handlers.text as Parameters<typeof withMathEscapes>[0] | undefined;
    if (!text) return opts;
    return { ...opts, handlers: { ...handlers, text: withMathEscapes(text) } as typeof opts.handlers };
  });
}

export const mathPlugins = [
  remarkMathPlugin,
  mathInlineSchema,
  mathInlineView,
  mathInlineInputRule,
  mathBlockInputRule,
  mathKeys,
  mathBlockSchema,
  mathBlockPlugin,
].flat();
