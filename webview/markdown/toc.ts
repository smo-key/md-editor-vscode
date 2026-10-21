/**
 * A live table of contents for the Markdown editor.
 *
 * The TOC is an ordinary nested bullet list of anchor links, so every other
 * Markdown renderer shows a working table of contents — nothing here invents
 * syntax. What makes it *ours* is a marker comment on the line directly above
 * it, the same trick `tableFullWidth.ts` uses for full-width tables:
 *
 *     <!-- ken:toc -->
 *     - [Setup](#setup)
 *       - [Install](#install)
 *     - [Usage](#usage)
 *
 * Four pieces make that work:
 *
 *   - a remark plugin that swallows the comment on parse and flags the list
 *     that follows it (a marker followed by anything else stays a comment);
 *   - an extension of the commonmark `bullet_list` schema carrying that flag
 *     as a `toc` node attribute, and serializing a flagged list back as the
 *     marker plus the list;
 *   - a ProseMirror plugin that rebuilds the first flagged list from the
 *     document's headings after every change that touches them;
 *   - a node decoration making the list non-editable and captioned.
 *
 * One deliberate deviation from the obvious implementation: a flagged list is
 * serialized as a single verbatim block (marker and list lines together)
 * rather than as an mdast `html` node joined to an mdast `list`. The reason is
 * Ken's list serialization — Milkdown stores `spread` as a *string*, which
 * mdast-util-to-markdown does not recognize as a boolean, so it puts a blank
 * line between every list item and its nested list. A table of contents full
 * of blank lines is unreadable, and writing the block ourselves keeps the
 * on-disk form tight and byte-stable across saves.
 */
import type {
  Node as ProseNode,
  NodeType,
  Schema,
} from "@milkdown/kit/prose/model";
import type {
  MarkdownNode,
  ParserState,
  SerializerState,
} from "@milkdown/kit/transformer";
import type { Ctx } from "@milkdown/kit/ctx";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import { Plugin, PluginKey, Selection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { commandsCtx } from "@milkdown/kit/core";
import {
  bulletListSchema,
  clearTextInCurrentBlockCommand,
} from "@milkdown/kit/preset/commonmark";
import { $command, $prose, $remark } from "@milkdown/kit/utils";

import { collectHeadings, type HeadingEntry } from "./anchors";

/** The marker written to disk, exactly as it is emitted. */
export const TOC_COMMENT = "<!-- ken:toc -->";

/** The single item a table of contents shows while the document has no headings. */
export const TOC_EMPTY_TEXT = "No headings yet";

/** The class the decoration puts on the list, for the editor's CSS. */
export const TOC_CLASS = "ken-toc";

/**
 * The class marking an entry for an `h1`. Level is not the same thing as
 * nesting depth — a document whose shallowest heading is an `h2` has
 * top-level entries that are not `h1`s — so the decoration carries it.
 */
export const TOC_H1_CLASS = "ken-toc-h1";

/**
 * Meta key set on the transactions the sync plugin appends, so a caller (and
 * the tests) can tell them apart from the edit that triggered them.
 */
export const TOC_SYNC_META = "kenTocSync";

/** Tolerant of spacing, so a hand-edited file still round trips. */
const MARKER_RE = /^<!--\s*ken:toc\s*-->$/;

/**
 * Milkdown keeps `spread` as a string; a tight list parses to `"false"`, and
 * the lists we build have to match it or every reconcile pass would consider
 * a freshly parsed table of contents stale.
 */
const TIGHT = "false";

/** Does this mdast `html` node carry the TOC marker? */
export function isTocComment(value: unknown): boolean {
  return typeof value === "string" && MARKER_RE.test(value.trim());
}

// ---------------------------------------------------------------------------
// The entries: a pure function of the document's headings.
// ---------------------------------------------------------------------------

export interface TocEntry {
  /** The heading's plain text, as the link label. */
  text: string;
  /** The heading's GitHub-style slug, as the link target. */
  slug: string;
  /** Indent level, 0 for a top-level entry. */
  depth: number;
  /** The heading's own level (1-6). Styling wants it; nesting does not. */
  level: number;
}

/** The heading fields a TOC entry is derived from. */
export type TocHeading = Pick<HeadingEntry, "text" | "slug" | "level">;

/**
 * Turn headings into TOC entries. Nesting is relative rather than absolute:
 * the first heading is always a top-level entry whatever its level, and a
 * skipped level costs one indent rather than two (`h1` then `h3` nests once).
 * Headings with no text are dropped — there is nothing to link.
 */
export function tocEntries(headings: readonly TocHeading[]): TocEntry[] {
  const entries: TocEntry[] = [];
  // Levels of the entries this one could be nested under, outermost first.
  const open: number[] = [];
  for (const heading of headings) {
    const text = heading.text.trim();
    if (!text) continue;
    while (open.length > 0 && open[open.length - 1]! >= heading.level) {
      open.pop();
    }
    entries.push({
      text,
      slug: heading.slug,
      depth: open.length,
      level: heading.level,
    });
    open.push(heading.level);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// The node: a pure function of the entries.
// ---------------------------------------------------------------------------

function requireType(schema: Schema, name: string): NodeType {
  const type = schema.nodes[name];
  if (!type) throw new Error(`missing node type: ${name}`);
  return type;
}

/**
 * The list node a document's headings should produce: a nested bullet list of
 * anchor links, or a single plain item when there is nothing to list.
 *
 * The result is compared with `eq` against the list already in the document,
 * so it has to be built with exactly the attributes the parser produces.
 */
export function buildTocList(
  schema: Schema,
  headings: readonly TocHeading[],
): ProseNode {
  const list = requireType(schema, "bullet_list");
  const item = requireType(schema, "list_item");
  const paragraph = requireType(schema, "paragraph");
  const link = schema.marks.link;
  const entries = tocEntries(headings);

  if (entries.length === 0) {
    return list.create({ spread: TIGHT, toc: true }, [
      item.create({ spread: TIGHT }, [
        paragraph.create(null, schema.text(TOC_EMPTY_TEXT)),
      ]),
    ]);
  }

  /** The items at `depth` starting at `index`, and the index after them. */
  const build = (index: number, depth: number): [ProseNode[], number] => {
    const items: ProseNode[] = [];
    let i = index;
    while (i < entries.length && entries[i]!.depth >= depth) {
      const entry = entries[i]!;
      const marks = link ? [link.create({ href: `#${entry.slug}` })] : [];
      const content: ProseNode[] = [
        paragraph.create(null, schema.text(entry.text, marks)),
      ];
      i += 1;
      if (i < entries.length && entries[i]!.depth > depth) {
        const [children, next] = build(i, depth + 1);
        i = next;
        content.push(list.create({ spread: TIGHT }, children));
      }
      items.push(item.create({ spread: TIGHT }, content));
    }
    return [items, i];
  };

  const [items] = build(0, 0);
  return list.create({ spread: TIGHT, toc: true }, items);
}

/** The first `bullet_list` flagged as a table of contents. */
export function findTocList(
  doc: ProseNode,
): { pos: number; node: ProseNode } | undefined {
  let found: { pos: number; node: ProseNode } | undefined;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === "bullet_list" && node.attrs.toc === true) {
      found = { pos, node };
      return false;
    }
    return true;
  });
  return found;
}

/**
 * The headings a table of contents at `range` should list: the ones that
 * follow it. A table of contents indexes what comes after it, so the title it
 * usually sits under is not one of its own entries — and anything that somehow
 * ended up inside the list is excluded by the same rule.
 */
function headingsFor(
  doc: ProseNode,
  range?: { from: number; to: number },
): HeadingEntry[] {
  const headings = collectHeadings(doc);
  if (!range) return headings;
  return headings.filter((h) => h.pos >= range.to);
}

// ---------------------------------------------------------------------------
// Markdown: verbatim serialization of a flagged list.
// ---------------------------------------------------------------------------

/** Escape the characters that would break out of a link label. */
function escapeLabel(text: string): string {
  return text.replace(/([\\[\]])/g, "\\$1");
}

/** Wrap a destination in angle brackets when it needs them. */
function formatHref(href: string): string {
  return /[\s()<>]/.test(href) ? `<${href}>` : href;
}

/** The href of the first link mark in a paragraph, if it has one. */
function linkHref(paragraph: ProseNode | null | undefined): string | null {
  if (!paragraph) return null;
  let href: string | null = null;
  paragraph.descendants((node) => {
    if (href !== null) return false;
    const mark = node.marks.find((m) => m.type.name === "link");
    if (mark && typeof mark.attrs.href === "string") href = mark.attrs.href;
    return href === null;
  });
  return href;
}

function tocLines(list: ProseNode, depth: number, out: string[]): void {
  list.forEach((item) => {
    const first = item.firstChild;
    const label = escapeLabel((first?.textContent ?? "").trim());
    const href = linkHref(first);
    const bullet = "  ".repeat(depth) + "- ";
    out.push(bullet + (href ? `[${label}](${formatHref(href)})` : label));
    item.forEach((child) => {
      if (child.type.name === "bullet_list") tocLines(child, depth + 1, out);
    });
  });
}

/** The whole on-disk block for a flagged list: the marker and the list lines. */
export function tocMarkdown(list: ProseNode): string {
  const lines: string[] = [];
  tocLines(list, 0, lines);
  return [TOC_COMMENT, ...lines].join("\n");
}

// ---------------------------------------------------------------------------
// remark: consume the comment on the way in.
// ---------------------------------------------------------------------------

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  [key: string]: unknown;
}

/**
 * Is this block the marker comment? Commonmark's `remarkHtmlTransformer` may
 * already have rewrapped the block-level `html` node as a paragraph holding a
 * single inline `html` child, so both shapes count.
 */
function isMarkerBlock(node: MdastNode): boolean {
  if (node.type === "html") return isTocComment(node.value);
  if (node.type !== "paragraph") return false;
  const only = node.children?.length === 1 ? node.children[0] : undefined;
  return only?.type === "html" && isTocComment(only.value);
}

/**
 * Drop every marker comment immediately followed by a bullet list, flagging
 * that list instead. A marker with anything else after it (or nothing) is left
 * alone: it is then just an HTML comment, and stays one.
 */
function transformTree(node: MdastNode): void {
  const children = node.children;
  if (!Array.isArray(children)) return;
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (!child) continue;
    transformTree(child);
    if (!isMarkerBlock(child)) continue;
    const next = children[i + 1];
    if (next?.type !== "list" || next.ordered === true) continue;
    next.toc = true;
    children.splice(i, 1);
  }
}

function remarkToc() {
  return (tree: MdastNode) => {
    transformTree(tree);
  };
}

/** The remark plugin that turns the marker into a node attribute. */
export const remarkTocPlugin = $remark("kenToc", () => remarkToc as never);

// ---------------------------------------------------------------------------
// Schema: the commonmark bullet list, plus a `toc` attribute.
// ---------------------------------------------------------------------------

/**
 * The `bullet_list` schema with a `toc` attribute. Registering it after the
 * preset replaces the preset's own node (schema registration is keyed by node
 * name, last one wins), so every other list plugin keeps working.
 */
export const tocBulletListSchema = bulletListSchema.extendSchema(
  (prev) => (ctx) => {
    const base = prev(ctx);
    const baseParse = base.parseMarkdown;
    const baseSerialize = base.toMarkdown;
    return {
      ...base,
      attrs: { ...(base.attrs ?? {}), toc: { default: false } },
      parseMarkdown: {
        match: baseParse.match,
        // Mirrors the preset's own runner, plus the flag the remark transform
        // left on the mdast node.
        runner: (state: ParserState, node: MarkdownNode, type: NodeType) => {
          const spread = node.spread != null ? `${node.spread}` : "false";
          state
            .openNode(type, { spread, toc: node.toc === true })
            .next(node.children ?? [])
            .closeNode();
        },
      },
      toMarkdown: {
        match: baseSerialize.match,
        runner: (state: SerializerState, node: ProseNode) => {
          if (node.attrs.toc === true) {
            // The marker and the list, written as one verbatim block: see the
            // note at the top of this file.
            state.addNode("html", undefined, tocMarkdown(node));
            return;
          }
          baseSerialize.runner(state, node);
        },
      },
    };
  },
);

// ---------------------------------------------------------------------------
// Insertion
// ---------------------------------------------------------------------------

/**
 * Put a table of contents at the selection: an empty block is replaced by it,
 * otherwise it goes after the block the selection is in.
 */
export const insertTocCommand = $command<undefined, "InsertToc">(
  "InsertToc",
  () => () => (state, dispatch) => {
    const { $from } = state.selection;
    if ($from.depth < 1) return false;
    const list = buildTocList(state.schema, collectHeadings(state.doc));
    const parent = $from.parent;
    const empty = parent.isTextblock && parent.content.size === 0;
    const from = empty ? $from.before($from.depth) : $from.after($from.depth);
    const to = empty ? $from.after($from.depth) : from;
    if (dispatch) {
      const tr = state.tr.replaceWith(from, to, list);
      const after = Math.min(from + list.nodeSize, tr.doc.content.size);
      const selection = Selection.near(tr.doc.resolve(after), 1);
      dispatch(tr.setSelection(selection).scrollIntoView());
    }
    return true;
  },
);

// ---------------------------------------------------------------------------
// Live sync
// ---------------------------------------------------------------------------

/**
 * The transaction bringing the document's first table of contents back in
 * line with its headings, or `null` when there is nothing to do.
 *
 * Because the replacement *is* the expected node, running this again on the
 * resulting state returns `null` — that equality is what keeps the
 * `appendTransaction` loop from spinning.
 */
export function tocReconcileTransaction(
  state: EditorState,
): Transaction | null {
  const found = findTocList(state.doc);
  if (!found) return null;
  const from = found.pos;
  const to = from + found.node.nodeSize;
  const expected = buildTocList(state.schema, headingsFor(state.doc, { from, to }));
  if (found.node.eq(expected)) return null;

  const tr = state.tr.replaceWith(from, to, expected);
  tr.setMeta(TOC_SYNC_META, true);
  // The list is not editable, so the selection should never be inside it —
  // but if it is, park the caret after the list rather than let it be mapped
  // into content that no longer exists.
  const { selection } = state;
  if (selection.from >= from && selection.to <= to) {
    const after = Math.min(from + expected.nodeSize, tr.doc.content.size);
    tr.setSelection(Selection.near(tr.doc.resolve(after), 1));
  }
  return tr;
}

/**
 * Keep the first table of contents in sync with the headings.
 *
 * `appendTransaction` covers editing; the plugin's view reconciles once on
 * mount, so opening a document whose on-disk table of contents has gone stale
 * rewrites it (which marks the document changed — that is the point).
 */
export const tocSyncPlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey("ken-toc-sync"),
      appendTransaction: (transactions, _oldState, newState) => {
        if (!transactions.some((tr) => tr.docChanged)) return null;
        return tocReconcileTransaction(newState);
      },
      view: (view) => {
        // Not during view construction: dispatching there would re-enter the
        // update it is in the middle of.
        queueMicrotask(() => {
          if (view.isDestroyed) return;
          const tr = tocReconcileTransaction(view.state);
          if (tr) view.dispatch(tr);
        });
        return {};
      },
    }),
);

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const tocDecorationKey = new PluginKey<DecorationSet>("ken-toc-decorations");

function decorate(doc: ProseNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "bullet_list") return true;
    if (node.attrs.toc === true) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: TOC_CLASS,
          // Stray edits inside the list would be silently overwritten by the
          // next reconcile, so make it read-only. Link clicks still reach the
          // anchor plugin, which listens on the editor's own DOM.
          contenteditable: "false",
        }),
      );
      // The list is built from these same entries in order, so the nth
      // top-level item is the nth top-level entry.
      const top = tocEntries(
        headingsFor(doc, { from: pos, to: pos + node.nodeSize }),
      ).filter((entry) => entry.depth === 0);
      let index = 0;
      let itemPos = pos + 1;
      node.forEach((item) => {
        if (top[index]?.level === 1) {
          decorations.push(
            Decoration.node(itemPos, itemPos + item.nodeSize, {
              class: TOC_H1_CLASS,
            }),
          );
        }
        index += 1;
        itemPos += item.nodeSize;
      });
      return false;
    }
    return true;
  });
  return DecorationSet.create(doc, decorations);
}

/** The `ken-toc` class and the read-only flag on every flagged list. */
export const tocDecorations = $prose(
  () =>
    new Plugin<DecorationSet>({
      key: tocDecorationKey,
      state: {
        init: (_config, state) => decorate(state.doc),
        apply: (tr, previous) => (tr.docChanged ? decorate(tr.doc) : previous),
      },
      props: {
        decorations: (state) => tocDecorationKey.getState(state),
      },
    }),
);

// ---------------------------------------------------------------------------
// Menu wiring
// ---------------------------------------------------------------------------

// lucide `list-tree`.
const TOC_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/></svg>';

/** Structural shape of Crepe's `GroupBuilder`, so we need no Crepe import. */
export interface TocGroupBuilder {
  getGroup: (key: string) => {
    addItem: (
      key: string,
      item: { label: string; icon: string; onRun?: (ctx: Ctx) => void },
    ) => unknown;
  };
}

/**
 * Add a "Table of contents" item to a Crepe slash / block-edit menu, in the
 * list group next to the plain bullet and ordered lists.
 */
export function addTocMenuItem(
  builder: TocGroupBuilder,
  group = "list",
  label = "Table of contents",
): void {
  builder.getGroup(group).addItem("toc", {
    label,
    icon: TOC_ICON,
    onRun: (ctx: Ctx) => {
      const commands = ctx.get(commandsCtx);
      commands.call(clearTextInCurrentBlockCommand.key);
      commands.call(insertTocCommand.key, undefined);
    },
  });
}

/** Everything the table of contents needs, ready for `editor.use(...)`. */
export const tocPlugins = [
  remarkTocPlugin,
  tocBulletListSchema,
  insertTocCommand,
  tocSyncPlugin,
  tocDecorations,
].flat();
