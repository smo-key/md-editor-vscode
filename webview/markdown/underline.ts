/**
 * Underline. Markdown has no underline syntax, so it is written as HTML: an
 * `<ins>` element, which GitHub (and most renderers) show underlined. Files
 * that use `<u>` keep `<u>`: the mark remembers which tag it came from.
 *
 * On parse, a matched `<ins>…</ins>` (or `<u>…</u>`) pair of inline HTML
 * nodes in the same paragraph becomes an `underline` mdast node, then the
 * `underline` mark; on save the mark is written back as the same tags.
 */
import type { Mark } from "@milkdown/kit/prose/model";
import type { MarkdownNode, ParserState, SerializerState } from "@milkdown/kit/transformer";
import type { MarkType } from "@milkdown/kit/prose/model";
import { $markSchema, $remark } from "@milkdown/kit/utils";

interface MdNode {
  type: string;
  value?: string;
  tag?: string;
  children?: MdNode[];
}

const OPEN = /^<(ins|u)>$/i;
const CLOSE = /^<\/(ins|u)>$/i;

/** Wrap matched `<ins>`/`<u>` pairs among `node`'s children, depth first. */
export function wrapUnderlines(node: MdNode): void {
  const children = node.children;
  if (!Array.isArray(children)) return;
  for (const child of children) wrapUnderlines(child);
  for (let i = 0; i < children.length; i++) {
    const open = children[i]!;
    const m = open.type === "html" ? OPEN.exec(open.value?.trim() ?? "") : null;
    if (!m) continue;
    const tag = m[1]!.toLowerCase();
    let depth = 0;
    for (let j = i + 1; j < children.length; j++) {
      const c = children[j]!;
      if (c.type !== "html") continue;
      const v = c.value?.trim() ?? "";
      const o = OPEN.exec(v);
      const cl = CLOSE.exec(v);
      if (o && o[1]!.toLowerCase() === tag) depth++;
      else if (cl && cl[1]!.toLowerCase() === tag) {
        if (depth > 0) {
          depth--;
          continue;
        }
        const wrapped: MdNode = { type: "underline", tag, children: children.slice(i + 1, j) };
        // Pairs nested inside this one are just more of the same underline.
        wrapUnderlines(wrapped);
        wrapped.children = wrapped.children!.flatMap((c) => (c.type === "underline" ? (c.children ?? []) : [c]));
        children.splice(i, j - i + 1, wrapped);
        break;
      }
    }
  }
}

interface RemarkProcessor {
  data: () => Record<string, unknown>;
}

interface ToMarkdownState {
  enter: (name: string) => () => void;
  containerPhrasing: (node: MdNode, info: Record<string, unknown>) => string;
}

function remarkUnderline(this: RemarkProcessor) {
  const data = this.data();
  const extensions = (data.toMarkdownExtensions ??= []) as unknown[];
  extensions.push({
    handlers: {
      underline(node: MdNode, _parent: unknown, state: ToMarkdownState, info: Record<string, unknown>) {
        const tag = node.tag === "u" ? "u" : "ins";
        const exit = state.enter("underline");
        const inner = state.containerPhrasing(node, { ...info, before: ">", after: "<" });
        exit();
        return `<${tag}>${inner}</${tag}>`;
      },
    },
  });
  return (tree: MdNode) => wrapUnderlines(tree);
}

export const remarkUnderlinePlugin = $remark("kenUnderline", () => remarkUnderline as never);

export const underlineSchema = $markSchema("underline", () => ({
  attrs: { tag: { default: "ins" } },
  parseDOM: [
    { tag: "ins", getAttrs: () => ({ tag: "ins" }) },
    { tag: "u", getAttrs: () => ({ tag: "u" }) },
    {
      style: "text-decoration",
      getAttrs: (value: string) => (/underline/.test(value) ? { tag: "ins" } : false),
    },
  ],
  toDOM: (mark: Mark) => ["u", { class: "ken-underline", "data-tag": mark.attrs.tag }, 0],
  parseMarkdown: {
    match: (node: MarkdownNode) => node.type === "underline",
    runner: (state: ParserState, node: MarkdownNode, markType: MarkType) => {
      state.openMark(markType, { tag: node.tag === "u" ? "u" : "ins" });
      state.next(node.children ?? []);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark: Mark) => mark.type.name === "underline",
    runner: (state: SerializerState, mark: Mark) => {
      state.withMark(mark, "underline", undefined, { tag: mark.attrs.tag });
    },
  },
}));

export const underlinePlugins = [remarkUnderlinePlugin, underlineSchema].flat();
