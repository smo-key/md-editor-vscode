/**
 * Lines, paragraphs and lists inside table cells.
 *
 * A GFM table cell holds one line of inline Markdown, so anything more is
 * written the way GitHub renders it: inline HTML.
 *
 *     | a<br>b | <ul><li>one</li><li>[x] done</li></ul> |
 *
 * - Paragraphs (and hard line breaks) are separated by `<br>`.
 * - Bulleted and numbered lists are `<ul>`/`<ol>` with `<li>` items, nested as
 *   deep as needed; a checklist item starts with `[ ] ` or `[x] `.
 *
 * In the editor a cell holds real blocks (`paragraph`, `bullet_list`,
 * `ordered_list`), so every list command works inside it. On the way in, a
 * from-markdown transform rebuilds those blocks from the cell's HTML tags
 * before any remark transformer runs (Milkdown's own drops every `<br>`); a
 * cell whose tags don't nest properly is left exactly as it was.
 */
import type { Node as ProseNode, NodeType } from "@milkdown/kit/prose/model";
import { Fragment } from "@milkdown/kit/prose/model";
import { tableCellSchema, tableHeaderSchema } from "@milkdown/kit/preset/gfm";
import type { MarkdownNode, ParserState, SerializerState } from "@milkdown/kit/transformer";
import { $remark } from "@milkdown/kit/utils";

/** What a table cell may hold in the editor. */
export const CELL_CONTENT = "(paragraph | bullet_list | ordered_list)+";

interface Md {
  type: string;
  value?: string;
  children?: Md[];
  [key: string]: unknown;
}

const TAG = /^<\s*(\/?)\s*(ul|ol|li|br)\s*\/?\s*>$/i;

interface Container {
  blocks: Md[];
  inline: Md[];
  /** A `<br>` was just seen: the next paragraph exists even if empty. */
  pending: boolean;
  item?: Md;
}
interface ListFrame {
  list: Md;
}
type Frame = Container | ListFrame;

const isList = (f: Frame): f is ListFrame => "list" in f;

function flush(c: Container, force = false) {
  if (c.inline.length || c.pending || force) c.blocks.push({ type: "paragraph", children: c.inline });
  c.inline = [];
  c.pending = false;
}

const TASK = /^\[([ xX])\]\s/;

function closeItem(c: Container) {
  flush(c);
  const item = c.item!;
  if (item.children!.length === 0 || item.children![0]!.type !== "paragraph") {
    item.children!.unshift({ type: "paragraph", children: [] });
  }
  const first = item.children![0]!.children!;
  const text = first[0];
  if (text?.type === "text" && TASK.test(text.value ?? "")) {
    item.checked = text.value![1] !== " ";
    text.value = text.value!.replace(TASK, "");
    if (!text.value) first.shift();
  }
}

/**
 * The cell's phrasing children as blocks, or null when the cell has no
 * `<br>`/list tags (or they don't nest properly) and stays as it is.
 */
export function cellBlocks(children: Md[]): Md[] | null {
  if (!children.some((c) => c.type === "html" && TAG.test((c.value ?? "").trim()))) return null;
  const root: Container = { blocks: [], inline: [], pending: false };
  const stack: Frame[] = [root];
  for (const node of children) {
    const top = stack[stack.length - 1]!;
    const m = node.type === "html" ? TAG.exec((node.value ?? "").trim()) : null;
    if (!m) {
      if (isList(top)) {
        if (node.type === "text" && !(node.value ?? "").trim()) continue;
        return null;
      }
      top.inline.push(node);
      continue;
    }
    const closing = m[1] === "/";
    const tag = m[2]!.toLowerCase();
    if (tag === "br") {
      if (isList(top)) return null;
      flush(top, true);
      top.pending = true;
    } else if (tag === "li") {
      if (!closing) {
        if (!isList(top)) return null;
        const item: Md = { type: "listItem", spread: false, checked: null, children: [] };
        top.list.children!.push(item);
        stack.push({ blocks: item.children!, inline: [], pending: false, item });
      } else {
        if (isList(top) || !top.item) return null;
        closeItem(top);
        stack.pop();
      }
    } else if (!closing) {
      if (isList(top)) return null;
      flush(top);
      const list: Md = { type: "list", ordered: tag === "ol", start: tag === "ol" ? 1 : null, spread: false, children: [] };
      top.blocks.push(list);
      stack.push({ list });
    } else {
      // `</ul>` closes an item left open, as browsers do.
      let frame = stack[stack.length - 1]!;
      if (!isList(frame) && frame.item) {
        closeItem(frame);
        stack.pop();
        frame = stack[stack.length - 1]!;
      }
      if (!isList(frame) || (frame.list.ordered ? "ol" : "ul") !== tag) return null;
      if (frame.list.children!.length === 0) return null;
      stack.pop();
    }
  }
  if (stack.length !== 1) return null;
  flush(root);
  if (root.blocks.length === 0) root.blocks.push({ type: "paragraph", children: [] });
  return root.blocks;
}

function transform(node: Md): void {
  if (node.type === "tableCell") {
    const blocks = cellBlocks(node.children ?? []);
    if (blocks) {
      node.children = blocks;
      node.kenBlocks = true;
    }
    return;
  }
  for (const child of node.children ?? []) transform(child);
}

interface RemarkProcessor {
  data: () => Record<string, unknown>;
}

function remarkCellBlocks(this: RemarkProcessor) {
  const data = this.data();
  // A from-markdown transform runs as the tree is built, ahead of every remark
  // transformer (Milkdown's preserve-empty-line plugin deletes `<br>`s).
  const extensions = (data.fromMarkdownExtensions ??= []) as unknown[];
  extensions.push({ transforms: [(tree: Md) => transform(tree)] });
}

export const remarkCellBlocksPlugin = $remark("kenCellBlocks", () => remarkCellBlocks as never);

// --- Serializing -------------------------------------------------------------

const html = (state: SerializerState, value: string) => state.addNode("html", undefined, value);

/** A paragraph's inline content, hard breaks written as `<br>`. */
function writeInline(state: SerializerState, para: ProseNode) {
  let run: ProseNode[] = [];
  const out = () => {
    if (run.length) state.next(Fragment.from(run));
    run = [];
  };
  para.forEach((child) => {
    if (child.type.name === "hardbreak" || child.type.name === "hard_break") {
      out();
      html(state, "<br>");
    } else run.push(child);
  });
  out();
}

function writeBlocks(state: SerializerState, container: ProseNode) {
  let prev: string | null = null;
  container.forEach((child) => {
    const kind = child.type.name;
    if (kind === "paragraph") {
      if (prev === "paragraph") html(state, "<br>");
      writeInline(state, child);
    } else if (kind === "bullet_list" || kind === "ordered_list") {
      const tag = kind === "ordered_list" ? "ol" : "ul";
      html(state, `<${tag}>`);
      child.forEach((item) => {
        html(state, "<li>");
        const checked = item.attrs.checked;
        if (checked === true) html(state, "[x] ");
        else if (checked === false) html(state, "[ ] ");
        writeBlocks(state, item);
        html(state, "</li>");
      });
      html(state, `</${tag}>`);
    } else {
      // Anything else (not reachable through the cell schema): its text.
      if (prev === "paragraph") html(state, "<br>");
      state.addNode("text", undefined, child.textContent);
    }
    prev = kind;
  });
}

/** A cell with no text and no inline atoms (images, HTML). */
function isEmptyCell(node: ProseNode): boolean {
  let empty = true;
  node.descendants((child) => {
    if (child.isInline) empty = false;
    return empty;
  });
  return empty;
}

function cellSchema<T extends typeof tableCellSchema | typeof tableHeaderSchema>(schema: T) {
  return schema.extendSchema((prev) => (ctx) => {
    const base = prev(ctx);
    return {
      ...base,
      content: CELL_CONTENT,
      parseMarkdown: {
        match: base.parseMarkdown.match,
        runner: (state: ParserState, node: MarkdownNode, type: NodeType) => {
          if (!node.kenBlocks) {
            base.parseMarkdown.runner(state, node, type);
            return;
          }
          state.openNode(type, { alignment: node.align as string });
          state.next(node.children);
          state.closeNode();
        },
      },
      toMarkdown: {
        match: base.toMarkdown.match,
        runner: (state: SerializerState, node: ProseNode) => {
          state.openNode("tableCell");
          // Milkdown writes an empty paragraph as `<br />`; an empty cell is just empty.
          if (!isEmptyCell(node)) writeBlocks(state, node);
          state.closeNode();
        },
      },
    };
  });
}

/** The GFM cell schemas, holding blocks; registered after the preset's (last wins). */
export const tableCellBlockSchemas = [
  remarkCellBlocksPlugin,
  cellSchema(tableCellSchema),
  cellSchema(tableHeaderSchema),
].flat();
