// DOM pieces shared by the diff view (diff.ts) and a chat agent's pending
// edits in the editor (agentEdits.ts).
import { DOMSerializer, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { EditorState, Plugin, TextSelection, type PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, EditorView } from "@milkdown/kit/prose/view";
import { changeMark, type RemovedWidget, type TablePart } from "./diffModel";

/** Wrap the text between offsets `[from, to)` of `root`'s text in spans of `className`. */
function highlightText(root: HTMLElement, ranges: [number, number][], className: string) {
  if (!ranges.length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
  let offset = 0;
  for (const text of texts) {
    const start = offset;
    const end = offset + text.data.length;
    offset = end;
    const hits = ranges.filter(([a, b]) => a < end && b > start).map(([a, b]) => [Math.max(a, start) - start, Math.min(b, end) - start]);
    for (const [a, b] of hits.reverse()) {
      const target = text.splitText(a);
      target.splitText(b - a);
      const span = document.createElement("span");
      span.className = className;
      target.replaceWith(span);
      span.append(target);
    }
  }
}

/** A cell of an edited table's old version, or an empty one where only the new version has the column or row. */
function oldCell(serializer: DOMSerializer, cell: ProseNode | null, header: boolean): HTMLElement {
  if (!cell) {
    const gap = document.createElement(header ? "th" : "td");
    gap.className = "ken-diff-gap";
    return gap;
  }
  const dom = serializer.serializeNode(cell);
  return dom instanceof HTMLElement ? dom : document.createElement(header ? "th" : "td");
}

/** A piece of an edited table's old version, shown inside the new table: a row, a cell, or a cell's old text. */
function tablePart(serializer: DOMSerializer, part: TablePart, words: [number, number][], modified?: boolean[]): HTMLElement {
  if (part.kind === "row") {
    const tr = document.createElement("tr");
    tr.className = "ken-diff-removed-part ken-diff-row ken-diff-widget-part";
    for (const cell of part.cells) tr.append(oldCell(serializer, cell, part.header));
    return tr;
  }
  if (part.kind === "cell") {
    const td = oldCell(serializer, part.cell, part.header);
    td.classList.add("ken-diff-removed-part", "ken-diff-widget-part");
    return td;
  }
  const box = document.createElement("div");
  box.className = "ken-diff-cell-old";
  box.append(serializer.serializeFragment(part.cell.content));
  highlightText(box, words.filter((_, i) => !modified?.[i]), "ken-diff-removed-text");
  highlightText(box, words.filter((_, i) => modified?.[i]), "ken-diff-modified-text");
  return box;
}

/** The read-only views drawing removed blocks, by their widget's element, to destroy with it. */
const blockViews = new WeakMap<HTMLElement, EditorView>();

const keyName = (k: Plugin | PluginKey) => (k as unknown as { key: string }).key;

/**
 * A removed block, drawn exactly as the editor draws it (the same node views,
 * decorations and styles) but not editable, its removed words marked: a
 * read-only view of a document holding only that block, with the plugins of
 * `host` (without their views) except `skip` (the caller's own diff highlights).
 * Pieces of an edited table are table rows and cells, drawn as plain HTML.
 */
export function removedBlock(host: EditorView, w: RemovedWidget, skip: PluginKey[] = []): HTMLElement {
  if (w.part) {
    const el = tablePart(DOMSerializer.fromSchema(host.state.schema), w.part, w.words, w.modified);
    el.contentEditable = "false";
    return el;
  }
  const box = document.createElement("div");
  box.className = "ken-diff-widget";
  box.contentEditable = "false";
  const node = w.entry.node;
  const skipped = new Set(skip.map(keyName));
  // A plugin's view is its UI (menus, toolbars, handles): copies without one keep its decorations and attributes.
  const plugins = host.state.plugins.filter((p) => !skipped.has(keyName(p))).map((p) => (p.spec.view ? new Plugin({ ...p.spec, view: undefined }) : p));
  // The block before it, hidden, so the rules that space a block by what precedes it (`p + h2`) apply as in the editor.
  // Not a block with a view of its own (a table, code): those are costly to draw, and no such rule depends on them.
  const before = w.before && !host.props.nodeViews?.[w.before.type.name] ? w.before : null;
  // And a hidden paragraph after it to hold the caret, which would otherwise be in the block (opening a math block's source).
  const { schema } = host.state;
  const after = schema.nodes.paragraph!.create();
  const blocks = before ? [before, node, after] : [node, after];
  const doc = schema.topNodeType.create(null, blocks);
  const state = EditorState.create({ schema, doc, plugins, selection: TextSelection.create(doc, doc.content.size - 1) });
  const at = before ? before.nodeSize : 0;
  const end = at + node.nodeSize;
  const cls = `ken-diff-removed${w.entry.pair ? " ken-diff-edited" : ""}`;
  const decos = DecorationSet.create(state.doc, [
    ...(before ? [Decoration.node(0, at, { class: "ken-diff-context" })] : []),
    Decoration.node(end, end + after.nodeSize, { class: "ken-diff-context" }),
    Decoration.node(at, at + node.nodeSize, { class: cls }),
    ...(w.changes ?? [])
      .filter((r) => r.to > r.from)
      .map((r) => {
        const m = changeMark(r, at, "removed");
        const attrs: Record<string, string> = { class: m.className };
        if (m.title) attrs.title = m.title;
        return m.block ? Decoration.node(m.from, m.to, attrs) : Decoration.inline(m.from, m.to, attrs);
      }),
  ]);
  const view = new EditorView(box, {
    state,
    editable: () => false,
    // Nothing typed, toggled or dropped here changes anything.
    dispatchTransaction: () => {},
    nodeViews: host.props.nodeViews,
    markViews: host.props.markViews,
    decorations: () => decos,
  });
  view.dom.classList.add("ken-diff-widget-view");
  blockViews.set(box, view);
  return box;
}

/** `view` and the views drawing removed blocks inside it (for printing, which builds and labels their code blocks too). */
export function withRemovedViews(view: EditorView): EditorView[] {
  const inner = Array.from(view.dom.querySelectorAll<HTMLElement>(".ken-diff-widget"), (box) => blockViews.get(box));
  return [view, ...inner.filter((v): v is EditorView => !!v)];
}

/** Release a removed block's view: the widget's `destroy`. */
export function destroyRemovedBlock(dom: Node) {
  if (!(dom instanceof HTMLElement)) return;
  blockViews.get(dom)?.destroy();
  blockViews.delete(dom);
}

/** A widget key that changes whenever what the widget draws does (so its view is rebuilt), and only then. */
export function removedKey(prefix: string, i: number, w: RemovedWidget): string {
  const text = `${w.part?.kind ?? "block"}|${w.before?.type.name ?? ""}|${w.entry.node.toString()}|${JSON.stringify(w.words)}`;
  let h = 0;
  for (let k = 0; k < text.length; k++) h = (Math.imul(h, 31) + text.charCodeAt(k)) | 0;
  return `${prefix}-${i}-${(h >>> 0).toString(36)}`;
}

/** The element a block is drawn as, for the rules that match on it: `p`, `ul`, `h2`… */
function tagOf(node: ProseNode): string {
  switch (node.type.name) {
    case "paragraph":
      return "p";
    case "heading":
      return `h${Math.min(6, Math.max(1, Number(node.attrs.level) || 1))}`;
    case "bullet_list":
      return "ul";
    case "ordered_list":
      return "ol";
    case "blockquote":
      return "blockquote";
    case "hr":
      return "hr";
    default:
      return "div";
  }
}

/**
 * The combined view's removed blocks as widgets of `host`. After the last of
 * them at a position goes a hidden stand-in for it (the element it is drawn
 * as), so the block after it is spaced as if the removed block were there.
 * `wrap` adjusts each element (the agent edits mark theirs to skip printing).
 */
export function removedWidgets(host: EditorView, widgets: RemovedWidget[], prefix: string, skip: PluginKey[], wrap: (el: HTMLElement) => HTMLElement = (el) => el): Decoration[] {
  const size = host.state.doc.content.size;
  const out: Decoration[] = [];
  widgets.forEach((w, i) => {
    const pos = Math.min(w.pos, size);
    out.push(
      Decoration.widget(pos, () => wrap(removedBlock(host, w, skip)), {
        side: -1,
        key: removedKey(prefix, i, w),
        ignoreSelection: true,
        stopEvent: () => true,
        destroy: destroyRemovedBlock,
      }),
    );
    const next = widgets[i + 1];
    if (w.part || (next && Math.min(next.pos, size) === pos && !next.part)) return;
    const tag = tagOf(w.entry.node);
    out.push(
      Decoration.widget(
        pos,
        () => {
          const el = document.createElement(tag);
          el.className = "ken-diff-standin";
          el.hidden = true;
          return el;
        },
        { side: -0.5, key: `${prefix}-standin-${i}-${tag}`, ignoreSelection: true },
      ),
    );
  });
  return out;
}

/** Marks of words (or other content) changed inside a block. */
const CHANGED_TEXT = ".ken-diff-added-text, .ken-diff-removed-text, .ken-diff-modified-text, .ken-diff-modified, .ken-diff-cell-old";

/**
 * The stops inside an edited table: each run of added or removed rows, the
 * table itself for its added or removed columns (their header cells stick to
 * the top, so the table is where they are), and each cell whose text changed.
 * A row or column wholly added or removed is one stop, not one per cell.
 */
export function tableStops(block: HTMLElement): HTMLElement[] {
  const table = block.querySelector<HTMLElement>("table.children");
  if (!table) return [block];
  const stops: HTMLElement[] = [];
  let inRows = false;
  Array.from(table.querySelectorAll<HTMLTableRowElement>(":scope > tbody > tr, :scope > tr")).forEach((tr, i) => {
    if (tr.classList.contains("ken-diff-row")) {
      if (!inRows) stops.push(tr);
      inRows = true;
      return;
    }
    inRows = false;
    for (const cell of Array.from(tr.children) as HTMLElement[]) {
      const column = /ken-diff-(added|removed)-part/.test(cell.className) && !cell.classList.contains("ken-diff-cell-edited");
      if (column) {
        if (i === 0 && !stops.includes(table)) stops.push(table);
      } else if (cell.matches(".ken-diff-modified") || cell.querySelector(CHANGED_TEXT)) stops.push(cell);
    }
  });
  return stops;
}
