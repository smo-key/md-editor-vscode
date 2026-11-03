// DOM pieces shared by the diff view (diff.ts) and a chat agent's pending
// edits in the editor (agentEdits.ts).
import type { DOMSerializer, Node as ProseNode } from "@milkdown/kit/prose/model";
import type { RemovedWidget, TablePart } from "./diffModel";

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
function tablePart(serializer: DOMSerializer, part: TablePart, words: [number, number][]): HTMLElement {
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
  highlightText(box, words, "ken-diff-removed-text");
  return box;
}

/** A removed block, drawn as it was (not editable), its removed words marked. */
export function removedBlock(serializer: DOMSerializer, w: RemovedWidget): HTMLElement {
  if (w.part) {
    const el = tablePart(serializer, w.part, w.words);
    el.contentEditable = "false";
    return el;
  }
  const box = document.createElement("div");
  box.className = `ken-diff-removed ken-diff-widget${w.entry.pair ? " ken-diff-edited" : ""}`;
  box.contentEditable = "false";
  const dom = serializer.serializeNode(w.entry.node);
  // A table of contents looks as it does in the editor (its class comes from a decoration there).
  if (w.entry.node.type.name === "bullet_list" && w.entry.node.attrs.toc === true && dom instanceof HTMLElement) dom.classList.add("ken-toc");
  box.append(dom);
  highlightText(box, w.words, "ken-diff-removed-text");
  return box;
}
