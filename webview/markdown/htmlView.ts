/**
 * Raw HTML in Markdown (part of GFM). Milkdown keeps each HTML chunk as an
 * inline atom showing its source, which can be neither read as GitHub shows
 * it nor edited. This node view:
 *
 * - renders a self-contained chunk (`<kbd>Ctrl</kbd>`, `<br>`,
 *   `<p align="center"><img src="logo.png"></p>`) as sanitized HTML, the way
 *   GitHub does, with relative image sources resolved for the webview;
 * - shows a fragment (a lone `<details>` or `</details>` tag, whose content
 *   is ordinary Markdown in between) or a comment as a quiet code chip;
 * - edits the source on double-click (Enter or blur commits, Escape cancels).
 *
 * The Markdown is untouched: the node's `value` is written back verbatim.
 */
import DOMPurify from "dompurify";
import { htmlSchema } from "@milkdown/kit/preset/commonmark";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, type EditorState } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView, type NodeView } from "@milkdown/kit/prose/view";
import { $prose, $view } from "@milkdown/kit/utils";

const VOID = new Set(["area", "br", "col", "embed", "hr", "img", "input", "source", "track", "wbr"]);

// GFM's "disallowed raw HTML" tag filter, plus anything active.
const FORBID_TAGS = [
  "title", "textarea", "style", "xmp", "iframe", "noembed", "noframes", "script", "plaintext",
  "object", "embed", "form", "input", "button", "select", "link", "meta", "base",
];

/**
 * Whether `html` stands on its own: a comment, a void element, or one element
 * whose closing tag ends the chunk with every tag inside it balanced.
 */
export function isSelfContained(html: string): boolean {
  const s = html.trim();
  if (!s.startsWith("<")) return false;
  if (/^<!--[\s\S]*-->$/.test(s)) return false;
  const tags = [...s.matchAll(/<\/?([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g)];
  if (tags.length === 0) return false;
  const stack: string[] = [];
  for (const [whole, rawName, selfClose] of tags) {
    const name = rawName.toLowerCase();
    if (whole.startsWith("</")) {
      if (stack.pop() !== name) return false;
    } else if (!VOID.has(name) && !selfClose) {
      stack.push(name);
    }
  }
  if (stack.length) return false;
  // One top-level element (or a run of void ones), not text with a tag in it.
  return /^<[a-zA-Z]/.test(s) && />$/.test(s);
}

export function sanitize(html: string): DocumentFragment {
  const template = document.createElement("template");
  // Nothing is rendered if the sanitiser is unavailable.
  template.innerHTML = DOMPurify.isSupported
    ? DOMPurify.sanitize(html, { FORBID_TAGS, FORBID_ATTR: ["style"] })
    : "";
  const fragment = template.content;
  // Belt and braces: nothing active survives, whatever the sanitiser did.
  for (const el of fragment.querySelectorAll(FORBID_TAGS.join(","))) el.remove();
  for (const el of fragment.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      const value = attr.value.trim().toLowerCase();
      if (/^on/i.test(attr.name) || attr.name === "style" || value.startsWith("javascript:")) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return fragment;
}

export type ResolveSrc = (src: string) => string | Promise<string>;

class HtmlView implements NodeView {
  dom: HTMLElement;
  private editing = false;

  constructor(
    private node: ProseNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly resolveSrc: ResolveSrc | undefined,
  ) {
    this.dom = document.createElement("span");
    this.dom.dataset.type = "html";
    this.dom.contentEditable = "false";
    this.dom.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.edit();
    });
    this.render();
  }

  private get value(): string {
    return this.node.attrs.value as string;
  }

  private render() {
    this.dom.replaceChildren();
    this.dom.dataset.value = this.value;
    this.dom.title = "Double-click to edit HTML";
    if (isSelfContained(this.value)) {
      this.dom.className = "ken-html ken-html-rendered";
      const fragment = sanitize(this.value);
      if (this.resolveSrc) {
        for (const img of fragment.querySelectorAll("img[src]")) {
          const src = img.getAttribute("src")!;
          void Promise.resolve(this.resolveSrc(src)).then((url) => img.setAttribute("src", url));
        }
      }
      for (const a of fragment.querySelectorAll("a")) a.setAttribute("tabindex", "-1");
      this.dom.append(fragment);
      // Empty after sanitising (e.g. only a <script>): fall back to the source.
      if (this.dom.childNodes.length > 0) return;
    }
    this.dom.className = /^\s*<!--/.test(this.value) ? "ken-html ken-html-comment" : "ken-html ken-html-raw";
    this.dom.textContent = this.value;
  }

  private edit() {
    if (this.editing || !this.view.editable) return;
    this.editing = true;
    const input = document.createElement("textarea");
    input.className = "ken-html-input";
    input.value = this.value;
    input.rows = Math.min(12, this.value.split("\n").length);
    input.spellcheck = false;
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      this.editing = false;
      const pos = this.getPos();
      const next = input.value;
      if (commit && pos !== undefined && next !== this.value) {
        const tr = next.trim()
          ? this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, value: next })
          : this.view.state.tr.delete(pos, pos + this.node.nodeSize);
        this.view.dispatch(tr);
      } else {
        this.render();
      }
      this.view.focus();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        finish(true);
      }
    });
    input.addEventListener("blur", () => finish(true));
    this.dom.className = "ken-html ken-html-editing";
    this.dom.replaceChildren(input);
    input.focus();
    input.select();
  }

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    if (this.editing) return true;
    const changed = node.attrs.value !== this.node.attrs.value;
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

export function htmlViewPlugin(resolveSrc?: ResolveSrc) {
  return $view(htmlSchema.node, () => (node, view, getPos) => new HtmlView(node, view, getPos, resolveSrc));
}

// ---------------------------------------------------------------------------
// Inline tag pairs: `Press <kbd>Ctrl</kbd>` arrives as three nodes (an opening
// tag, text, a closing tag). The text between a matched pair is wrapped in the
// real element, as GitHub renders it, and the tag chips are hidden unless the
// caret is in or beside the pair, so the source stays reachable for editing.
// ---------------------------------------------------------------------------

const INLINE_TAGS = new Set([
  "abbr", "b", "big", "cite", "code", "del", "dfn", "em", "i", "ins", "kbd", "mark", "q", "s",
  "samp", "small", "span", "strike", "strong", "sub", "sup", "tt", "u", "var",
]);
const OPEN = /^<([a-zA-Z][a-zA-Z0-9]*)(\s[^>]*)?>$/;
const CLOSE = /^<\/([a-zA-Z][a-zA-Z0-9]*)\s*>$/;

export interface TagPair {
  tag: string;
  /** Start and end of the opening tag node. */
  open: [number, number];
  /** Start and end of the closing tag node. */
  close: [number, number];
}

/** Matched inline tag pairs in every textblock of `doc`. */
export function findTagPairs(doc: ProseNode): TagPair[] {
  const pairs: TagPair[] = [];
  doc.descendants((block, blockPos) => {
    if (!block.inlineContent) return true;
    const stack: { tag: string; from: number; to: number }[] = [];
    block.forEach((child, offset) => {
      if (child.type.name !== "html") return;
      const value = String(child.attrs.value).trim();
      const from = blockPos + 1 + offset;
      const to = from + child.nodeSize;
      const open = OPEN.exec(value);
      if (open && !value.endsWith("/>") && INLINE_TAGS.has(open[1].toLowerCase())) {
        stack.push({ tag: open[1].toLowerCase(), from, to });
        return;
      }
      const close = CLOSE.exec(value);
      if (!close) return;
      const tag = close[1].toLowerCase();
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag !== tag) continue;
        const o = stack[i];
        stack.length = i;
        pairs.push({ tag, open: [o.from, o.to], close: [from, to] });
        break;
      }
    });
    return false;
  });
  return pairs;
}

function decorate(state: EditorState): DecorationSet {
  const { from, to } = state.selection;
  const decorations: Decoration[] = [];
  for (const pair of findTagPairs(state.doc)) {
    const active = to >= pair.open[0] && from <= pair.close[1];
    const cls = active ? "ken-html-tag" : "ken-html-tag ken-html-tag-hidden";
    decorations.push(Decoration.node(pair.open[0], pair.open[1], { class: cls }));
    decorations.push(Decoration.node(pair.close[0], pair.close[1], { class: cls }));
    if (pair.open[1] < pair.close[0]) {
      decorations.push(
        Decoration.inline(pair.open[1], pair.close[0], { nodeName: pair.tag, class: "ken-html-inline" }),
      );
    }
  }
  return DecorationSet.create(state.doc, decorations);
}

export const inlineHtmlPlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey("ken-inline-html"),
      props: { decorations: decorate },
    }),
);
