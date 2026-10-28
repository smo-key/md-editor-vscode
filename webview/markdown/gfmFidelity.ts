/**
 * Keeps GitHub-flavoured Markdown faithful on save where Milkdown/Crepe would
 * otherwise rewrite it:
 *
 * - Tight lists stay tight. Milkdown stores a list's `spread` as the *string*
 *   `"true"`/`"false"` and hands it to mdast-util-to-markdown as-is; that
 *   library only honours a boolean, so every list with a nested list was saved
 *   loose, with a blank line between each item. `tightListJoin` reads the
 *   string the way it was meant.
 * - Image alt text survives. Crepe's image block repurposes the alt text to
 *   store its resize ratio, so `![A diagram](x.png)` came back as
 *   `![1.00](x.png)`. The extended schema keeps the alt text in its own
 *   attribute and only falls back to writing the ratio for an image that has
 *   no alt text and was actually resized.
 * - Empty table cells stay empty (see tableCellBlocks.ts).
 */
import type { Node as ProseNode, NodeType } from "@milkdown/kit/prose/model";
import { imageBlockSchema } from "@milkdown/kit/component/image-block";
import type { MarkdownNode, ParserState, SerializerState } from "@milkdown/kit/transformer";

interface JoinNode {
  type: string;
  spread?: unknown;
}

/**
 * An mdast-util-to-markdown `join` rule: blank lines between the children of
 * a list or list item only when it is spread (loose). Mirrors the library's
 * own default for boolean `spread`, extended to Milkdown's string form.
 */
export function tightListJoin(left: JoinNode, right: JoinNode, parent: JoinNode): number | undefined {
  if (parent.type !== "list" && parent.type !== "listItem") return undefined;
  if (typeof parent.spread !== "string") return undefined;
  // Two paragraphs (or a paragraph and a definition) always need a blank
  // line between them, or they would merge into one paragraph.
  if (left.type === "paragraph" && (right.type === "paragraph" || right.type === "definition")) return 1;
  return parent.spread === "true" ? 1 : 0;
}

const isRatio = (alt: string) => /^\d+(\.\d+)?$/.test(alt.trim()) && Number(alt) > 0;

/** Crepe's image block, plus the image's real alt text. */
export const imageBlockAltSchema = imageBlockSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: { ...(base.attrs ?? {}), alt: { default: "", validate: "string" } },
    // Copied and pasted (as HTML), the alt text comes along too.
    parseDOM: (base.parseDOM ?? []).map((rule) => ({
      ...rule,
      getAttrs: (dom: HTMLElement | string) => {
        const attrs = rule.getAttrs ? rule.getAttrs(dom as never) : {};
        if (!attrs || typeof dom === "string") return attrs;
        return { ...attrs, alt: dom.getAttribute("alt") ?? "" };
      },
    })),
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state: ParserState, node: MarkdownNode, type: NodeType) => {
        const alt = typeof node.alt === "string" ? node.alt : "";
        const ratio = isRatio(alt) ? Number(alt) : 1;
        state.addNode(type, {
          src: (node.url as string) ?? "",
          caption: (node.title as string) ?? "",
          ratio,
          alt: isRatio(alt) ? "" : alt,
        });
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state: SerializerState, node: ProseNode) => {
        const { src, caption, ratio, alt } = node.attrs as {
          src: string;
          caption: string;
          ratio: number;
          alt: string;
        };
        const resized = Number.isFinite(ratio) && Math.abs(ratio - 1) > 0.005;
        state.openNode("paragraph");
        state.addNode("image", undefined, undefined, {
          ...(caption ? { title: caption } : {}),
          url: src,
          alt: alt || (resized ? ratio.toFixed(2) : ""),
        });
        state.closeNode();
      },
    },
  };
});


/**
 * One newline at the end of the file. Crepe keeps an empty paragraph after a
 * trailing list, table or code block so there is always somewhere to type;
 * it should not add blank lines to the end of the file.
 */
export function normalizeTrailingNewlines(markdown: string): string {
  return markdown.replace(/\n{2,}$/, "\n");
}
