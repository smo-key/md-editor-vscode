/**
 * Lists that end up directly next to each other become one list: a new list
 * made between two others (or right after one), or two lists left touching
 * when the paragraph between them is deleted. Only something else between
 * them keeps lists apart. Bulleted lists and checklists join each other (in
 * Markdown they are the same kind of list); a numbered list stays apart from
 * a bulleted one, since Markdown can't write them as one list. The joined
 * list keeps the first list's settings (numbering start, delimiter).
 *
 * Only lists a change brought together are joined: touching lists the file
 * already had (`- a` then `* b`, two lists in CommonMark) stay as they are,
 * so opening a file never alters it. A collaborator's change (already joined
 * on their side) is left alone too.
 */
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import { Mapping, canJoin } from "@milkdown/kit/prose/transform";
import { $prose } from "@milkdown/kit/utils";

import { isRemoteChange } from "../remoteChange";

const LISTS = new Set(["bullet_list", "ordered_list"]);

/** Positions between two touching lists of the same type, within `from`…`to`. */
export function listJoinPoints(doc: ProseNode, from: number, to: number): number[] {
  const points = new Set<number>();
  const lo = Math.max(0, from - 1);
  const hi = Math.min(doc.content.size, to + 1);
  doc.nodesBetween(lo, hi, (node, pos, parent, index) => {
    if (LISTS.has(node.type.name) && parent) {
      const next = index + 1 < parent.childCount ? parent.child(index + 1) : null;
      if (next?.type === node.type) points.add(pos + node.nodeSize);
      const prev = index > 0 ? parent.child(index - 1) : null;
      if (prev?.type === node.type) points.add(pos);
    }
    return !node.isTextblock;
  });
  return [...points].sort((a, b) => b - a);
}

/** Join touching lists in the region the transactions changed. */
export function joinAdjacentLists(trs: readonly Transaction[], oldState: EditorState, state: EditorState): Transaction | null {
  if (!trs.some((tr) => tr.docChanged) || isRemoteChange(trs)) return null;
  const start = oldState.doc.content.findDiffStart(state.doc.content);
  if (start == null) return null;
  const end = oldState.doc.content.findDiffEnd(state.doc.content);
  const to = end ? Math.max(end.b, start) : state.doc.content.size;
  // Only lists this change brought together: ones that already touched (in
  // the file as written, e.g. `- a` then `* b`) are left as they were.
  const mapping = new Mapping();
  for (const tr of trs) mapping.appendMapping(tr.mapping);
  const before = new Set(listJoinPoints(oldState.doc, start, end ? Math.max(end.a, start) : oldState.doc.content.size).map((p) => mapping.map(p)));
  const points = listJoinPoints(state.doc, start, to).filter((p) => !before.has(p));
  if (!points.length) return null;
  const tr = state.tr;
  // Right to left, so earlier positions stay valid.
  for (const pos of points) if (canJoin(tr.doc, pos)) tr.join(pos);
  return tr.docChanged ? tr : null;
}

export const listJoinPlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey("ken-list-join"),
      appendTransaction: joinAdjacentLists,
    }),
);
