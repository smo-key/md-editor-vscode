// Backspace resets a block to plain text in one press:
//
// - at the very start of a heading, the heading becomes a paragraph. Milkdown's
//   default `DowngradeHeading` shortcut steps one level at a time
//   (h3 → h2 → h1 → p), so we disable that shortcut and install our own;
// - in an empty list item (bullet, numbered or task, at any depth), the item
//   leaves every list it sits in and becomes a paragraph where it was. The
//   items around it stay in their lists, which split around the paragraph.
import type { Ctx } from "@milkdown/kit/ctx";
import { setBlockType } from "@milkdown/kit/prose/commands";
import { keymap } from "@milkdown/kit/prose/keymap";
import { liftListItem } from "@milkdown/kit/prose/schema-list";
import {
  TextSelection,
  type Command,
  type Transaction,
} from "@milkdown/kit/prose/state";
import {
  headingKeymap,
  headingSchema,
  listItemSchema,
  orderedListSchema,
  paragraphSchema,
} from "@milkdown/kit/preset/commonmark";
import type { EditorView } from "@milkdown/kit/prose/view";
import * as milkdown from "@milkdown/kit/utils";

/**
 * Drop Milkdown's stepwise heading downgrade. Pass this to
 * `editor.config(...)`; it must run before the editor state is built.
 */
export function disableHeadingDowngrade(ctx: Ctx) {
  ctx.update(headingKeymap.key, (keys) => ({
    ...keys,
    DowngradeHeading: { ...keys.DowngradeHeading, shortcuts: [] },
  }));
}

/** Nesting guard: no real document is anywhere near this deep. */
const MAX_LIFTS = 64;

/**
 * The Backspace behaviour on its own, so it can be run against an editor
 * state directly. Returns false (leaving the key to the next handler) unless
 * the selection is a cursor at offset 0 of a heading, or in the empty first
 * paragraph of a list item.
 */
export function blockBackspaceCommand(ctx: Ctx): Command {
  return (state, dispatch) => {
    const { selection } = state;
    if (!selection.empty) return false;
    const { $from } = selection;
    if ($from.parentOffset !== 0) return false;

    if ($from.parent.type === headingSchema.type(ctx)) {
      return setBlockType(paragraphSchema.type(ctx))(state, dispatch);
    }

    // An empty item: its paragraph is empty and is the item's first child.
    const listItem = listItemSchema.type(ctx);
    const depth = $from.depth;
    if (
      $from.parent.type !== paragraphSchema.type(ctx) ||
      $from.parent.content.size !== 0 ||
      depth < 2 ||
      $from.node(depth - 1).type !== listItem ||
      $from.index(depth - 1) !== 0
    ) {
      return false;
    }
    if (!dispatch) return true;

    // `liftListItem` takes an item out of one list at a time (a nested item
    // becomes an item of its parent list), so repeat it until the paragraph
    // is no longer inside any item — all in one transaction, so a single undo
    // puts the item back.
    const tr = state.tr;
    // The outermost list, so a numbered list split in two can keep counting.
    const outer = $from.node(1);
    const outerStart = $from.before(1);
    const outerEnd = outerStart + outer.nodeSize;
    for (let i = 0; i < MAX_LIFTS; i++) {
      const current = state.apply(tr);
      const $pos = current.selection.$from;
      let inItem = false;
      for (let d = $pos.depth; d > 0; d--) {
        if ($pos.node(d).type === listItem) inItem = true;
      }
      if (!inItem) break;
      let lifted: Transaction | undefined;
      liftListItem(listItem)(current, (t) => (lifted = t));
      if (!lifted) break;
      for (const step of lifted.steps) tr.step(step);
      tr.setSelection(TextSelection.create(tr.doc, lifted.selection.from));
    }
    if (!tr.docChanged) return false;
    if (outer.type === orderedListSchema.type(ctx)) {
      continueNumbering(tr, outer.attrs.order as number, outerEnd);
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/**
 * The numbered list the paragraph was lifted out of now sits either side of
 * it; a fresh list after a paragraph would restart at 1 on disk, so the part
 * after carries on from the part before (or from the list's own start when
 * the emptied item was its first).
 */
function continueNumbering(tr: Transaction, start: number, to: number) {
  // Only lists that came out of the original one are renumbered.
  const end = tr.mapping.map(to);
  const index = tr.selection.$from.index(0);
  const before = index > 0 ? tr.doc.child(index - 1) : null;
  const next =
    before && before.type.name === "ordered_list"
      ? ((before.attrs.order as number) ?? 1) + before.childCount
      : start;
  let pos = tr.selection.$from.after(1);
  for (let i = index + 1; i < tr.doc.childCount && pos < end; i++) {
    const node = tr.doc.child(i);
    if (node.type.name === "ordered_list") {
      tr.setNodeAttribute(pos, "order", next);
      return;
    }
    pos += node.nodeSize;
  }
}

/**
 * `$prose` plugins are prepended to the plugin list that `editorState` builds
 * (`[...prosePlugins, …, createKeymap(km.build())]`), so this keymap is
 * consulted before Milkdown's and ProseMirror's base keymaps — which would
 * otherwise join the heading into the block above, or merge the empty item's
 * paragraph into the previous item.
 */
export const headingBackspace = milkdown.$prose((ctx: Ctx) => {
  const command = blockBackspaceCommand(ctx);
  return keymap({
    Backspace: (state, dispatch, view) => {
      if (command(state, dispatch)) return true;
      // The heading-link button is a widget at the very start of a heading.
      // Arrowing onto offset 0 past it can leave the DOM caret at the start
      // while ProseMirror's selection still says offset 1 (the browser moves
      // the caret but ProseMirror doesn't pick the change up), and the
      // browser's own Backspace then merges the heading into the block above.
      // So when the two disagree, trust the caret the user can see.
      const pos = view && domCaretPos(view);
      if (pos === null || pos === undefined || pos === state.selection.from) {
        return false;
      }
      const synced = state.apply(
        state.tr.setSelection(TextSelection.create(state.doc, pos)),
      );
      return command(synced, dispatch);
    },
  });
});

/** Document position of a collapsed DOM caret inside the editor, if any. */
function domCaretPos(view: EditorView): number | null {
  const sel = view.dom.ownerDocument.getSelection();
  if (!sel || !sel.isCollapsed || !sel.anchorNode) return null;
  if (!view.dom.contains(sel.anchorNode)) return null;
  try {
    return view.posAtDOM(sel.anchorNode, sel.anchorOffset);
  } catch {
    return null;
  }
}
