/**
 * Numbered lists that nest the way a word processor's do.
 *
 * - A top-level numbered list counts `1.`, `2.`, … as ever.
 * - A numbered list inside another numbered list is lettered (`a.`, `b.`, …),
 *   one inside that is roman (`i.`, `ii.`, …), and the cycle repeats. Bullet
 *   lists in between don't count towards that depth.
 * - Tab under a numbered item starts a *bulleted* sub-list by default; typing
 *   `a. ` or `a) ` at the start of a nested item turns its level into a
 *   lettered one (starting at that letter).
 * - `)` as well as `.` can close an ordinal (`1)`, `a)`), per list.
 *
 * On disk every numbered list is plain CommonMark: nesting is just
 * indentation, so a lettered level is written `1.` and renders lettered here
 * (and, as it happens, on GitHub as roman). The `)` delimiter is CommonMark's
 * own `1)` list marker. Neither mdast nor Milkdown keeps a list's delimiter,
 * so a remark plugin reads it off the source on the way in, the ordered-list
 * schema carries it as an attribute, and on the way out the list is handed to
 * remark-stringify's own list handler with its ordered marker switched for
 * that one list.
 *
 * Plain `a. foo` lines in an existing file are left as the paragraphs
 * CommonMark says they are: guessing at lettered lists there would rewrite
 * prose that merely starts with an initial.
 */
import type { Ctx } from "@milkdown/kit/ctx";
import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import {
  bulletListSchema,
  listItemSchema,
  orderedListSchema,
} from "@milkdown/kit/preset/commonmark";
import { InputRule } from "@milkdown/kit/prose/inputrules";
import { keymap } from "@milkdown/kit/prose/keymap";
import {
  Fragment,
  Slice,
  type Node as ProseNode,
  type NodeType,
} from "@milkdown/kit/prose/model";
import { liftListItem } from "@milkdown/kit/prose/schema-list";
import {
  Plugin,
  PluginKey,
  type Command,
  type EditorState,
  type Transaction,
} from "@milkdown/kit/prose/state";
import { ReplaceAroundStep } from "@milkdown/kit/prose/transform";
import type {
  MarkdownNode,
  ParserState,
  SerializerState,
} from "@milkdown/kit/transformer";
import { $inputRule, $prose, $remark } from "@milkdown/kit/utils";

export type ListDelimiter = "." | ")";

// ---------------------------------------------------------------------------
// Labels: pure, so they can be tested directly.
// ---------------------------------------------------------------------------

/** 1 → a, 26 → z, 27 → aa, as spreadsheets and CSS `lower-alpha` count. */
export function toAlpha(n: number): string {
  if (!Number.isInteger(n) || n < 1) return String(n);
  let out = "";
  let rest = n;
  while (rest > 0) {
    rest -= 1;
    out = String.fromCharCode(97 + (rest % 26)) + out;
    rest = Math.floor(rest / 26);
  }
  return out;
}

const ROMAN: readonly [number, string][] = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

/** Lowercase roman numerals; numbers outside 1–3999 stay arabic. */
export function toRoman(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 3999) return String(n);
  let out = "";
  let rest = n;
  for (const [value, glyphs] of ROMAN) {
    while (rest >= value) {
      out += glyphs;
      rest -= value;
    }
  }
  return out;
}

/**
 * The label for the `n`th number of a numbered list nested `depth` numbered
 * lists deep (1 = top level): `1.`, then `a.`, then `i.`, then round again.
 */
export function orderedLabel(
  n: number,
  depth: number,
  delimiter: ListDelimiter = ".",
): string {
  const style = (Math.max(depth, 1) - 1) % 3;
  const body = style === 0 ? String(n) : style === 1 ? toAlpha(n) : toRoman(n);
  return `${body}${delimiter}`;
}

/** `a` → 1 … `z` → 26, for the letter typed to start a lettered list. */
export function letterValue(letter: string): number {
  return letter.toLowerCase().charCodeAt(0) - 96;
}

// ---------------------------------------------------------------------------
// Markdown: the per-list delimiter.
// ---------------------------------------------------------------------------

/** The mdast node type a `)` list is serialized as, so our handler sees it. */
const PAREN_LIST = "kenParenList";

interface MdastNode {
  type: string;
  ordered?: boolean | null;
  children?: MdastNode[];
  position?: { start?: { offset?: number } };
  kenDelimiter?: ListDelimiter;
  [key: string]: unknown;
}

/** Tag every ordered list whose first marker is `1)` rather than `1.`. */
function tagDelimiters(node: MdastNode, source: string): void {
  if (node.type === "list" && node.ordered) {
    const offset = node.children?.[0]?.position?.start?.offset;
    if (typeof offset === "number") {
      const marker = /^[ \t]*\d{1,9}([.)])/.exec(
        source.slice(offset, offset + 16),
      );
      if (marker?.[1] === ")") node.kenDelimiter = ")";
    }
  }
  for (const child of node.children ?? []) tagDelimiters(child, source);
}

export const remarkListDelimiterPlugin = $remark(
  "kenListDelimiter",
  () => () => (tree: unknown, file: unknown) => {
    const value = (file as { value?: unknown } | undefined)?.value;
    const source = typeof value === "string" ? value : String(file ?? "");
    tagDelimiters(tree as MdastNode, source);
  },
);

/** The ordered-list schema, plus the list's delimiter. */
export const delimitedOrderedListSchema = orderedListSchema.extendSchema(
  (prev) => (ctx) => {
    const base = prev(ctx);
    const baseParse = base.parseMarkdown;
    const baseSerialize = base.toMarkdown;
    return {
      ...base,
      attrs: { ...(base.attrs ?? {}), delimiter: { default: "." } },
      parseMarkdown: {
        match: baseParse.match,
        // The preset's own runner, plus the delimiter the remark plugin found.
        runner: (state: ParserState, node: MarkdownNode, type: NodeType) => {
          const spread = node.spread != null ? `${node.spread}` : "true";
          state
            .openNode(type, {
              spread,
              order: (node.start as number | null | undefined) ?? 1,
              delimiter: node.kenDelimiter === ")" ? ")" : ".",
            })
            .next(node.children)
            .closeNode();
        },
      },
      toMarkdown: {
        match: baseSerialize.match,
        runner: (state: SerializerState, node: ProseNode) => {
          if (node.attrs.delimiter !== ")") {
            baseSerialize.runner(state, node);
            return;
          }
          state.openNode(PAREN_LIST, undefined, {
            ordered: true,
            start: node.attrs.order ?? 1,
            spread: node.attrs.spread === "true",
          });
          state.next(node.content);
          state.closeNode();
        },
      },
    };
  },
);

type Handle = (
  node: MdastNode,
  parent: unknown,
  state: {
    options: { bulletOrdered?: string };
    handle: (node: MdastNode, parent: unknown, state: unknown, info: unknown) => string;
  },
  info: unknown,
) => string;

/**
 * remark-stringify writes every numbered list with one global marker. A `)`
 * list arrives as its own node type; this handler switches the marker for
 * that list and hands it, as an ordinary `list`, to the stock handler.
 */
const parenListHandler: Handle = (node, parent, state, info) => {
  const previous = state.options.bulletOrdered;
  state.options.bulletOrdered = ")";
  try {
    return state.handle({ ...node, type: "list" }, parent, state, info);
  } finally {
    state.options.bulletOrdered = previous;
  }
};

/** Pass to `editor.config(...)`, before the editor is created. */
export function configureListDelimiter(ctx: Ctx) {
  ctx.update(remarkStringifyOptionsCtx, (opts) => ({
    ...opts,
    handlers: { ...(opts.handlers ?? {}), [PAREN_LIST]: parenListHandler },
  }));
}

// ---------------------------------------------------------------------------
// Labels in the editor.
// ---------------------------------------------------------------------------

interface LabelFix {
  pos: number;
  attrs: Record<string, unknown>;
}

/**
 * Every list item whose label (what Crepe draws) or list type disagrees with
 * where it sits. Milkdown's own `syncListOrderPlugin` keeps labels at `N.`;
 * this runs after it and has the last word.
 */
export function labelFixes(
  doc: ProseNode,
  types: { ordered: NodeType; bullet: NodeType; item: NodeType },
): LabelFix[] {
  const fixes: LabelFix[] = [];
  const walk = (node: ProseNode, pos: number, depth: number) => {
    node.forEach((child, offset) => {
      const childPos = pos + offset;
      if (child.type === types.ordered) {
        const listDepth = depth + 1;
        const order = (child.attrs.order as number) ?? 1;
        const delimiter = child.attrs.delimiter === ")" ? ")" : ".";
        child.forEach((item, itemOffset, index) => {
          const itemPos = childPos + 1 + itemOffset;
          if (item.type === types.item) {
            const label = orderedLabel(order + index, listDepth, delimiter);
            if (item.attrs.label !== label || item.attrs.listType !== "ordered") {
              fixes.push({
                pos: itemPos,
                attrs: { ...item.attrs, label, listType: "ordered" },
              });
            }
          }
          walk(item, itemPos + 1, listDepth);
        });
      } else if (!child.isTextblock && !child.isLeaf) {
        walk(child, childPos + 1, depth);
      }
    });
  };
  walk(doc, 0, 0);
  return fixes;
}

function listTypes(ctx: Ctx) {
  return {
    ordered: orderedListSchema.type(ctx),
    bullet: bulletListSchema.type(ctx),
    item: listItemSchema.type(ctx),
  };
}

function fixLabels(ctx: Ctx, state: EditorState): Transaction | null {
  const fixes = labelFixes(state.doc, listTypes(ctx));
  if (fixes.length === 0) return null;
  const tr = state.tr;
  for (const fix of fixes) tr.setNodeMarkup(fix.pos, undefined, fix.attrs);
  // Presentation only: out of the undo history, like Milkdown's own sync.
  return tr.setMeta("addToHistory", false);
}

export const listLabelPlugin = $prose(
  (ctx) =>
    new Plugin({
      key: new PluginKey("ken-list-labels"),
      appendTransaction: (transactions, _old, state) =>
        transactions.some((tr) => tr.docChanged)
          ? fixLabels(ctx, state)
          : null,
      view: (view) => {
        // The document as loaded carries the parser's `N.` labels; correct
        // them once the view exists (a transaction can't run any earlier).
        queueMicrotask(() => {
          if (view.isDestroyed) return;
          const tr = fixLabels(ctx, view.state);
          if (tr) view.dispatch(tr);
        });
        return {};
      },
    }),
);

// ---------------------------------------------------------------------------
// Tab / Shift-Tab.
// ---------------------------------------------------------------------------

/** Give each item directly in the list at `listPos` the list's own type. */
function retypeItems(
  tr: Transaction,
  listPos: number,
  types: ReturnType<typeof listTypes>,
) {
  const list = tr.doc.nodeAt(listPos);
  if (!list) return;
  const listType = list.type === types.ordered ? "ordered" : "bullet";
  list.forEach((item, offset) => {
    if (item.type !== types.item || item.attrs.listType === listType) return;
    tr.setNodeMarkup(listPos + 1 + offset, undefined, {
      ...item.attrs,
      listType,
      label: listType === "bullet" ? "•" : item.attrs.label,
    });
  });
}

/** Position of the list directly holding the item the cursor is in. */
function cursorListPos(
  tr: Transaction,
  types: ReturnType<typeof listTypes>,
): number | null {
  const $pos = tr.selection.$from;
  for (let d = $pos.depth; d > 1; d--) {
    if ($pos.node(d).type === types.item) return $pos.before(d - 1);
  }
  return null;
}

/**
 * ProseMirror's `sinkListItem`, except for the list a new sub-level gets:
 * the nested list the item joins keeps its own type (so a lettered level
 * goes on being lettered), and a brand-new sub-level is always bulleted —
 * even under a numbered item, where the stock command would nest another
 * numbered list.
 */
export function sinkListItemCommand(ctx: Ctx): Command {
  return (state, dispatch) => {
    const types = listTypes(ctx);
    const { $from, $to } = state.selection;
    const range = $from.blockRange(
      $to,
      (node) => node.childCount > 0 && node.firstChild!.type === types.item,
    );
    if (!range) return false;
    const startIndex = range.startIndex;
    if (startIndex === 0) return false;
    const parent = range.parent;
    const nodeBefore = parent.child(startIndex - 1);
    if (nodeBefore.type !== types.item) return false;
    if (!dispatch) return true;

    const last = nodeBefore.lastChild;
    const nestedBefore =
      !!last && (last.type === types.ordered || last.type === types.bullet);
    const listType = nestedBefore ? last!.type : types.bullet;
    const inner = Fragment.from(nestedBefore ? types.item.create() : null);
    const slice = new Slice(
      Fragment.from(
        types.item.create(null, Fragment.from(listType.create(null, inner))),
      ),
      nestedBefore ? 3 : 1,
      0,
    );
    const before = range.start;
    const after = range.end;
    const tr = state.tr.step(
      new ReplaceAroundStep(
        before - (nestedBefore ? 3 : 1),
        after,
        before,
        after,
        slice,
        1,
        true,
      ),
    );
    const listPos = cursorListPos(tr, types);
    if (listPos !== null) retypeItems(tr, listPos, types);
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** `liftListItem`, with the lifted items taking their new list's type. */
export function liftListItemCommand(ctx: Ctx): Command {
  return (state, dispatch) => {
    const types = listTypes(ctx);
    let lifted: Transaction | undefined;
    if (!liftListItem(types.item)(state, (tr) => (lifted = tr))) return false;
    if (!dispatch || !lifted) return true;
    const listPos = cursorListPos(lifted, types);
    if (listPos !== null) retypeItems(lifted, listPos, types);
    dispatch(lifted.scrollIntoView());
    return true;
  };
}

export const listKeymap = $prose((ctx) =>
  keymap({
    Tab: sinkListItemCommand(ctx),
    "Shift-Tab": liftListItemCommand(ctx),
  }),
);

// ---------------------------------------------------------------------------
// Typing `a. `, `a) ` and `1) `.
// ---------------------------------------------------------------------------

/** A letter and its delimiter, as the whole of a nested item's text. */
export const LETTERED_LIST_RE = /^([a-z])([.)])\s$/;
/** CommonMark's other numbered-list marker. */
export const PAREN_LIST_RE = /^(\d{1,9})\)\s$/;

/**
 * Restyle the list the cursor's item sits in as a numbered list, so that the
 * item gets number `value` — from this item down, if it isn't the first. Only for an item's first paragraph; a lettered
 * list (`nestedOnly`) also has to be inside another list item, so a
 * top-level list stays `1.`.
 */
function restyleList(
  ctx: Ctx,
  state: EditorState,
  start: number,
  end: number,
  value: number,
  delimiter: ListDelimiter,
  nestedOnly: boolean,
): Transaction | null {
  const types = listTypes(ctx);
  const $start = state.doc.resolve(start);
  const depth = $start.depth;
  if ($start.parent.type.name !== "paragraph" || depth < 3) return null;
  if ($start.node(depth - 1).type !== types.item) return null;
  if ($start.index(depth - 1) !== 0) return null;
  const list = $start.node(depth - 2);
  if (list.type !== types.ordered && list.type !== types.bullet) return null;
  if (nestedOnly) {
    let nested = false;
    for (let d = depth - 3; d > 0; d--) {
      if ($start.node(d).type === types.item) nested = true;
    }
    if (!nested) return null;
  }
  const index = $start.index(depth - 2);
  const tr = state.tr.delete(start, end);
  // Typed partway down a list: the items above keep their style, and a new
  // list starts at this item. (A numbered list with the same delimiter is
  // simply renumbered instead — split, the two halves would merge again the
  // next time the file is read.)
  const sameStyle =
    list.type === types.ordered && list.attrs.delimiter === delimiter;
  if (index > 0 && !sameStyle) {
    tr.split(tr.mapping.map($start.before(depth - 1)));
  }
  const listPos = cursorListPos(tr, types);
  if (listPos === null) return null;
  const target = tr.doc.nodeAt(listPos)!;
  const offset = index > 0 && sameStyle ? index : 0;
  tr.setNodeMarkup(listPos, types.ordered, {
    ...(target.type === types.ordered ? target.attrs : {}),
    spread: target.attrs.spread,
    order: Math.max(1, value - offset),
    delimiter,
  });
  retypeItems(tr, listPos, types);
  return tr;
}

export const letteredListInputRule = $inputRule(
  (ctx) =>
    new InputRule(LETTERED_LIST_RE, (state, match, start, end) =>
      restyleList(
        ctx,
        state,
        start,
        end,
        letterValue(match[1]!),
        match[2] as ListDelimiter,
        true,
      ),
    ),
);

export const parenListInputRule = $inputRule(
  (ctx) =>
    new InputRule(PAREN_LIST_RE, (state, match, start, end) => {
      const value = Number(match[1]);
      // In a list item: restyle that list. Elsewhere: start a new list, as
      // `1. ` does.
      const restyled = restyleList(ctx, state, start, end, value, ")", false);
      if (restyled) return restyled;
      const $start = state.doc.resolve(start);
      if ($start.parent.type.name !== "paragraph") return null;
      if (start !== $start.start()) return null;
      const types = listTypes(ctx);
      const tr = state.tr.delete(start, end);
      const $pos = tr.doc.resolve(tr.mapping.map(start));
      const range = $pos.blockRange();
      if (!range) return null;
      tr.wrap(range, [
        { type: types.ordered, attrs: { order: value, delimiter: ")" } },
        { type: types.item },
      ]);
      return tr;
    }),
);

export const listStylePlugins = [
  remarkListDelimiterPlugin,
  delimitedOrderedListSchema,
  listLabelPlugin,
  listKeymap,
  letteredListInputRule,
  parenListInputRule,
].flat();
