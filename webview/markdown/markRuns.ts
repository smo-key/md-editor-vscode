/**
 * Keeps one emphasis (or strong, strikethrough, link, underline…) span one
 * span when something inside it carries another mark: a link, inline code,
 * math, nested strong. `*a https://a.com/x b*` came back as
 * `*a* *https://a.com/x* *b*` after any edit.
 *
 * Milkdown serializes each ProseMirror text node on its own: it opens the
 * node's marks, writes it, and closes them again, then merges a mark node
 * with an identical one right before it. Closing a mark moves the spaces at
 * its edges out of it (`*a *` is not emphasis), so the pieces of one span
 * were left with a space between them and never merged.
 *
 * The space Milkdown moved out is the only unmarked whitespace text that
 * isn't a ProseMirror text node: real text nodes are tagged (`kenText`) as
 * they are written. So two mark nodes of the same type and attributes with
 * only untagged spaces between them are one span split by that move, and
 * are joined back with the spaces inside. A space the user wrote outside
 * (`*a* *b*`) is a tagged text node, so those spans stay apart.
 */
import type { SerializerState } from "@milkdown/kit/transformer";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { $node, $remark } from "@milkdown/kit/utils";
import { defaultHandlers } from "mdast-util-to-markdown";

interface MdNode {
  type: string;
  value?: string;
  isMark?: boolean;
  kenText?: boolean;
  children?: MdNode[];
  [key: string]: unknown;
}

/** Whitespace Milkdown moved out of a mark it closed (never a real text node). */
const isMovedSpace = (n: MdNode) => n.type === "text" && !n.kenText && typeof n.value === "string" && /^ +$/.test(n.value);

const isSpan = (n: MdNode | undefined): n is MdNode & { children: MdNode[] } => !!n?.isMark && Array.isArray(n.children);

/** Everything but the children, for comparing two mark nodes. */
function attrsOf(n: MdNode): string {
  const { children: _c, ...rest } = n;
  return JSON.stringify(rest);
}

/**
 * `node` with the mark node of `type` lifted to its top, when it sits in a
 * chain of single-child mark nodes (`strong > emphasis > …` for
 * `emphasis`), so it can join a preceding `emphasis`. Otherwise `node`.
 */
function lift(node: MdNode, type: string): MdNode {
  if (node.type === type) return node;
  const chain: MdNode[] = [];
  let at: MdNode | undefined = node;
  while (isSpan(at) && at.type !== type && at.children.length === 1) {
    chain.push(at);
    at = at.children[0];
  }
  if (!isSpan(at) || at.type !== type) return node;
  // Rebuild the chain inside the target: type > chain[0] > … > target's children.
  let inner: MdNode[] = at.children;
  for (let i = chain.length - 1; i >= 0; i--) inner = [{ ...chain[i]!, children: inner }];
  return { ...at, children: inner };
}

/** Join mark spans split by moved spaces, throughout `node`. */
export function joinMarkRuns(node: MdNode): MdNode {
  const children = node.children;
  if (!Array.isArray(children)) return node;
  const out: MdNode[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    const prev = out.at(-1);
    if (isSpan(prev)) {
      // Untagged spaces, then a span of the same mark: `prev`'s own spaces.
      let j = i;
      while (j < children.length && isMovedSpace(children[j]!)) j++;
      const next = j < children.length ? lift(children[j]!, prev.type) : undefined;
      if (isSpan(next) && next.type === prev.type && attrsOf(next) === attrsOf(prev)) {
        out[out.length - 1] = { ...prev, children: [...prev.children, ...children.slice(i, j), ...next.children] };
        i = j;
        continue;
      }
    }
    out.push(child);
  }
  node.children = out.map(joinMarkRuns);
  return node;
}

interface RemarkProcessor {
  data: () => Record<string, unknown>;
}

type Handle = (node: MdNode, ...rest: unknown[]) => string;
const defaultRoot = defaultHandlers.root as unknown as Handle;

function remarkMarkRuns(this: RemarkProcessor) {
  const data = this.data();
  const extensions = (data.toMarkdownExtensions ??= []) as unknown[];
  extensions.push({ handlers: { root: (node: MdNode, ...rest: unknown[]) => defaultRoot(joinMarkRuns(node), ...rest) } });
}

export const remarkMarkRunsPlugin = $remark("kenMarkRuns", () => remarkMarkRuns as never);

/**
 * The commonmark `text` node (same name, so it replaces the preset's), with
 * each text it writes tagged as real text.
 */
export const taggedTextSchema = $node("text", () => ({
  group: "inline",
  parseMarkdown: {
    match: ({ type }) => type === "text",
    runner: (state, node) => {
      state.addText(node.value as string);
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "text",
    runner: (state: SerializerState, node: ProseNode) => {
      state.addNode("text", undefined, node.text as string, { kenText: true });
    },
  },
}));

export const markRunPlugins = [remarkMarkRunsPlugin, taggedTextSchema].flat();
