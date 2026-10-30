// Copying or cutting inside one table cell takes just what was selected: the
// cell's text and blocks, not the table around it. ProseMirror would copy the
// selection with its context (a one-cell table), which pastes elsewhere as a
// table, with the editor's `<!-- ken:table … -->` marker in the plain text.
// The plain text is just the text, a line per block.
import { DOMSerializer, Slice } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

const TABLE_PARTS = new Set(["table", "table_row", "table_header_row", "table_cell", "table_header"]);
const isCell = (name: string) => name === "table_cell" || name === "table_header";

/** The selection lies inside a single table cell (a text selection, not a cell selection). */
export function selectionInOneCell(state: EditorState): boolean {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || sel.empty) return false;
  const { $from, $to } = sel;
  for (let d = $from.depth; d > 0; d--) {
    if (isCell($from.node(d).type.name)) return d <= $to.depth && $to.before(d) === $from.before(d);
  }
  return false;
}

/** A slice copied from inside a cell, without the table, row and cell around it. */
export function unwrapCellSlice(slice: Slice): Slice {
  let { content, openStart, openEnd } = slice;
  while (content.childCount === 1 && openStart > 0 && openEnd > 0 && TABLE_PARTS.has(content.firstChild!.type.name)) {
    content = content.firstChild!.content;
    openStart--;
    openEnd--;
  }
  return new Slice(content, openStart, openEnd);
}

export const cellCopyPlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey("ken-cell-copy"),
      props: {
        handleDOMEvents: {
          copy: (view, event) => copy(view, event, false),
          cut: (view, event) => copy(view, event, true),
        },
      },
    }),
);

function copy(view: EditorView, event: ClipboardEvent, cut: boolean): boolean {
  const data = event.clipboardData;
  if (!data || !selectionInOneCell(view.state)) return false;
  const slice = unwrapCellSlice(view.state.selection.content());
  const box = document.createElement("div");
  box.append(DOMSerializer.fromSchema(view.state.schema).serializeFragment(slice.content));
  // Pasted back into the editor, the slice keeps its open ends (as ProseMirror's own copy does).
  if (box.firstElementChild) box.firstElementChild.setAttribute("data-pm-slice", `${slice.openStart} ${slice.openEnd} []`);
  event.preventDefault();
  data.clearData();
  data.setData("text/html", box.innerHTML);
  data.setData("text/plain", slice.content.textBetween(0, slice.content.size, "\n", "\n"));
  if (cut && view.editable) view.dispatch(view.state.tr.deleteSelection().scrollIntoView().setMeta("uiEvent", "cut"));
  return true;
}
