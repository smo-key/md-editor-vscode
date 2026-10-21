// Typing `/h1`, `/quote`, `/note` … as the whole of an otherwise empty
// paragraph or heading and then Space or Enter applies that block type
// straight away. The parsing half is pure so it can be unit tested; the
// ProseMirror half is a key handler (Space and Enter, ahead of Crepe's slash
// menu) plus the original input rule on a typed trailing space.
import {
  blockquoteSchema,
  bulletListSchema,
  codeBlockSchema,
  headingSchema,
  hrSchema,
  listItemSchema,
  orderedListSchema,
  paragraphSchema,
} from "@milkdown/kit/preset/commonmark";
import { createTable } from "@milkdown/kit/preset/gfm";
import type { Ctx } from "@milkdown/kit/ctx";
import { InputRule } from "@milkdown/kit/prose/inputrules";
import type { NodeType } from "@milkdown/kit/prose/model";
import {
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@milkdown/kit/prose/state";
import { findWrapping } from "@milkdown/kit/prose/transform";
import * as milkdown from "@milkdown/kit/utils";
import { collectHeadings } from "./anchors";
import { buildTocList } from "./toc";

export type AlertKind = "note" | "tip" | "important" | "warning" | "caution";

export type SlashShortcut =
  | { type: "heading"; level: number }
  | { type: "quote" }
  | { type: "code" }
  | { type: "divider" }
  | { type: "bulletList" }
  | { type: "orderedList" }
  | { type: "taskList" }
  | { type: "table" }
  | { type: "toc" }
  | { type: "alert"; kind: AlertKind };

/** Every keyword, aliases included, and what it asks for. */
const KEYWORDS: Record<string, SlashShortcut> = {
  h1: { type: "heading", level: 1 },
  h2: { type: "heading", level: 2 },
  h3: { type: "heading", level: 3 },
  h4: { type: "heading", level: 4 },
  h5: { type: "heading", level: 5 },
  h6: { type: "heading", level: 6 },
  quote: { type: "quote" },
  code: { type: "code" },
  divider: { type: "divider" },
  hr: { type: "divider" },
  bullet: { type: "bulletList" },
  ul: { type: "bulletList" },
  number: { type: "orderedList" },
  ol: { type: "orderedList" },
  todo: { type: "taskList" },
  task: { type: "taskList" },
  checklist: { type: "taskList" },
  table: { type: "table" },
  toc: { type: "toc" },
  note: { type: "alert", kind: "note" },
  tip: { type: "alert", kind: "tip" },
  important: { type: "alert", kind: "important" },
  warning: { type: "alert", kind: "warning" },
  caution: { type: "alert", kind: "caution" },
};

const KEYWORD_ALTERNATION = Object.keys(KEYWORDS).join("|");

/** The whole block text must be exactly the shortcut plus its trailing space. */
export const SLASH_SHORTCUT_RE = new RegExp(
  `^\\/(${KEYWORD_ALTERNATION})\\s$`,
  "i",
);

/** The whole block text is exactly the shortcut, as it is before Space/Enter. */
export const SLASH_COMMAND_RE = new RegExp(
  `^\\/(${KEYWORD_ALTERNATION})$`,
  "i",
);

function lookup(match: RegExpExecArray | null): SlashShortcut | null {
  if (!match) return null;
  return KEYWORDS[match[1].toLowerCase()] ?? null;
}

/**
 * Parse a block's full text (including the space that triggered the rule) into
 * the block type it asks for, or null when it is not a slash shortcut.
 */
export function parseSlashShortcut(text: string): SlashShortcut | null {
  return lookup(SLASH_SHORTCUT_RE.exec(text));
}

/** As `parseSlashShortcut`, for the bare text before Space or Enter. */
export function parseSlashCommand(text: string): SlashShortcut | null {
  return lookup(SLASH_COMMAND_RE.exec(text));
}

/** Wrap the (already emptied) textblock at `pos` in `type`, list items included. */
function wrapBlock(
  tr: Transaction,
  pos: number,
  type: NodeType,
  attrs: Record<string, unknown> | null = null,
): boolean {
  const $pos = tr.doc.resolve(pos);
  const range = $pos.blockRange();
  if (!range) return false;
  const wrapping = findWrapping(range, type, attrs);
  if (!wrapping) return false;
  tr.wrap(range, wrapping);
  return true;
}

/**
 * Replace the block text between `start` and `end` (the typed shortcut, which
 * must be the whole of a paragraph or heading) with the block it asks for.
 * Returns null, leaving the text alone, when the shortcut can't apply here.
 * Alerts are looked up by name at run time so this module stays independent
 * of the GitHub-alert plugin: without it the shortcut simply does nothing.
 */
export function applySlashShortcut(
  ctx: Ctx,
  state: EditorState,
  shortcut: SlashShortcut,
  start: number,
  end: number,
): Transaction | null {
  const $start = state.doc.resolve(start);
  const parent = $start.parent;
  if (parent.type.name !== "paragraph" && parent.type.name !== "heading") {
    return null;
  }
  // The shortcut has to be the entire block, not a fragment of a sentence.
  if (start !== $start.start() || end !== $start.end()) return null;

  const paragraph = paragraphSchema.type(ctx);
  const tr = state.tr.delete(start, end);
  // After the delete the block is empty; `pos` is inside it.
  const pos = tr.mapping.map(start);
  tr.setSelection(TextSelection.create(tr.doc, pos));
  // Headings can be wrapped/turned too, so normalise to a paragraph first.
  if (parent.type !== paragraph) {
    tr.setBlockType(pos, pos, paragraph);
  }

  switch (shortcut.type) {
    case "heading": {
      tr.setBlockType(pos, pos, headingSchema.type(ctx), {
        level: shortcut.level,
      });
      break;
    }
    case "quote": {
      if (!wrapBlock(tr, pos, blockquoteSchema.type(ctx))) return null;
      break;
    }
    case "code": {
      tr.setBlockType(pos, pos, codeBlockSchema.type(ctx));
      break;
    }
    case "divider": {
      const $pos = tr.doc.resolve(pos);
      tr.replaceWith($pos.before(), $pos.after(), [
        hrSchema.type(ctx).create(),
        paragraph.create(),
      ]);
      const sel = TextSelection.near(tr.doc.resolve(pos + 1));
      tr.setSelection(sel);
      break;
    }
    case "bulletList": {
      if (!wrapBlock(tr, pos, bulletListSchema.type(ctx))) return null;
      break;
    }
    case "orderedList": {
      if (!wrapBlock(tr, pos, orderedListSchema.type(ctx))) return null;
      break;
    }
    case "taskList": {
      // A task list is a bullet list whose items carry `checked`. Wrapping in
      // the item type alone lets ProseMirror pick the first list type that
      // can hold it, which is the numbered one.
      if (!wrapBlock(tr, pos, bulletListSchema.type(ctx))) return null;
      const $in = tr.selection.$from;
      for (let d = $in.depth; d > 0; d--) {
        if ($in.node(d).type === listItemSchema.type(ctx)) {
          tr.setNodeAttribute($in.before(d), "checked", false);
          break;
        }
      }
      break;
    }
    case "table": {
      // The same 3×3 table (a header row and two body rows) Crepe's menu
      // inserts, with the cursor in its first header cell.
      const $pos = tr.doc.resolve(pos);
      const from = $pos.before();
      tr.replaceWith(from, $pos.after(), createTable(ctx, 3, 3));
      tr.setSelection(TextSelection.near(tr.doc.resolve(from + 1)));
      break;
    }
    case "toc": {
      // Without the TOC plugin registered the `bullet_list` node has no
      // `toc` attribute, and the shortcut would produce a plain list: do
      // nothing instead and leave the typed text alone.
      const bulletList = bulletListSchema.type(ctx);
      if (!bulletList.spec.attrs?.toc) return null;
      const $pos = tr.doc.resolve(pos);
      const from = $pos.before();
      const list = buildTocList(state.schema, collectHeadings(tr.doc));
      tr.replaceWith(from, $pos.after(), list);
      const after = Math.min(from + list.nodeSize, tr.doc.content.size);
      tr.setSelection(Selection.near(tr.doc.resolve(after), 1));
      break;
    }
    case "alert": {
      const alert = state.schema.nodes[`github_alert`];
      if (!alert) return null;
      const $pos = tr.doc.resolve(pos);
      const node = alert.createAndFill({ kind: shortcut.kind });
      if (!node) return null;
      tr.replaceWith($pos.before(), $pos.after(), node);
      tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)));
      break;
    }
  }

  return tr;
}

/**
 * The transaction Space or Enter should run: the cursor is at the end of a
 * paragraph or heading whose whole text is a bare shortcut (`/h1`). Null
 * otherwise, so the key keeps its usual meaning.
 */
export function slashCommandTransaction(
  ctx: Ctx,
  state: EditorState,
): Transaction | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if ($from.parentOffset !== $from.parent.content.size) return null;
  const shortcut = parseSlashCommand($from.parent.textContent);
  if (!shortcut) return null;
  return applySlashShortcut(ctx, state, shortcut, $from.start(), $from.end());
}

/**
 * Space or Enter after a bare shortcut applies it. Crepe's slash menu opens on
 * the `/` and, while it is open, takes Enter for itself (from a capturing
 * `window` listener) to run whichever item its label filter left highlighted
 * — so `/table` would insert a table of contents, and `/hr` nothing at all.
 * This listener is registered when the editor is built, before the menu's
 * own, so it runs first; when it applies a shortcut it stops the event, the
 * block no longer starts with `/`, and the menu closes itself.
 */
export const slashShortcutKeys = milkdown.$prose(
  (ctx) =>
    new Plugin({
      key: new PluginKey("ken-slash-shortcut-keys"),
      view(view) {
        const onKeydown = (event: KeyboardEvent) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey)
            return;
          if (event.isComposing || !view.hasFocus()) return;
          const tr = slashCommandTransaction(ctx, view.state);
          if (!tr) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          view.dispatch(tr.scrollIntoView());
        };
        const win = view.dom.ownerDocument.defaultView ?? window;
        win.addEventListener("keydown", onKeydown, { capture: true });
        return {
          destroy: () =>
            win.removeEventListener("keydown", onKeydown, { capture: true }),
        };
      },
    }),
);

/** Input rule for a shortcut followed by a typed space. */
export const slashShortcutInputRule = milkdown.$inputRule(
  (ctx) =>
    new InputRule(SLASH_SHORTCUT_RE, (state, match, start, end) => {
      const shortcut = parseSlashShortcut(match[0]);
      if (!shortcut) return null;
      return applySlashShortcut(ctx, state, shortcut, start, end);
    }),
);
