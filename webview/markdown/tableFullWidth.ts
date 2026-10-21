/**
 * "Full width" tables for the Markdown editor.
 *
 * By default a table sizes to its content and sits in the text column. A table
 * can be widened to spill into the pane's gutters, and that choice has to
 * survive a save — without inventing syntax that other Markdown renderers
 * would show. The flag therefore rides along as an HTML comment on its own
 * line directly before the table:
 *
 *     <!-- ken:table full -->
 *     | a | b |
 *     | - | - |
 *
 * GitHub (and every other CommonMark renderer) drops the comment silently.
 *
 * Three pieces make that work: a remark plugin that swallows the comment on
 * parse and re-emits it on serialize, an extension of the GFM `table` schema
 * carrying the flag as a node attribute, and a ProseMirror plugin that mirrors
 * the attribute onto Crepe's `.milkdown-table-block` wrapper (as
 * `data-full-width`) and hangs the hover toggle off it.
 */
import type { NodeType, Node as ProseNode } from "@milkdown/kit/prose/model";
import type {
  MarkdownNode,
  ParserState,
  SerializerState,
} from "@milkdown/kit/transformer";
import type { EditorState } from "@milkdown/kit/prose/state";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { tableSchema } from "@milkdown/kit/preset/gfm";
import { $command, $prose, $remark } from "@milkdown/kit/utils";

/** The marker written to disk, exactly as it is emitted. */
export const TABLE_FULL_WIDTH_COMMENT = "<!-- ken:table full -->";

/** Tolerant of spacing, so a hand-edited file still round trips. */
const MARKER_RE = /^<!--\s*ken:table\s+full\s*-->$/;

/** Does this mdast `html` node carry the full-width marker? */
export function isTableFullWidthComment(value: unknown): boolean {
  return typeof value === "string" && MARKER_RE.test(value.trim());
}

// ---------------------------------------------------------------------------
// remark: consume the comment on the way in, re-emit it on the way out.
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
 * single inline `html` child, so both shapes count — remark plugin order is
 * not ours to pick.
 */
function isMarkerBlock(node: MdastNode): boolean {
  if (node.type === "html") return isTableFullWidthComment(node.value);
  if (node.type !== "paragraph") return false;
  const only = node.children?.length === 1 ? node.children[0] : undefined;
  return only?.type === "html" && isTableFullWidthComment(only.value);
}

/**
 * Drop every marker comment that is immediately followed by a table, flagging
 * that table instead. A marker with anything else after it (or nothing) is
 * left alone: it is then just an HTML comment, and stays one.
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
    if (next?.type !== "table") continue;
    next.fullWidth = true;
    children.splice(i, 1);
  }
}

interface RemarkProcessor {
  data: () => Record<string, unknown>;
}

function remarkTableFullWidth(this: RemarkProcessor) {
  const data = this.data();
  const extensions = (data.toMarkdownExtensions ??= []) as unknown[];
  extensions.push({
    // Keep the marker glued to its table: remark-stringify would otherwise
    // separate the two blocks with a blank line.
    join: [
      (left: MdastNode, right: MdastNode) =>
        left.type === "html" &&
        isTableFullWidthComment(left.value) &&
        right.type === "table"
          ? 0
          : undefined,
    ],
  });
  return (tree: MdastNode) => {
    transformTree(tree);
  };
}

/** The remark plugin handling both markdown directions. */
export const remarkTableFullWidthPlugin = $remark(
  "kenTableFullWidth",
  () => remarkTableFullWidth as never,
);

// ---------------------------------------------------------------------------
// Schema: the GFM table, plus a `fullWidth` attribute.
// ---------------------------------------------------------------------------

/**
 * The GFM `table` schema with a `fullWidth` attribute. Registering it after
 * the preset replaces the preset's `table` node (schema registration is keyed
 * by node name, last one wins), so the rest of the table plugins keep working.
 */
export const fullWidthTableSchema = tableSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  const baseParse = base.parseMarkdown;
  const baseSerialize = base.toMarkdown;
  return {
    ...base,
    attrs: { ...(base.attrs ?? {}), fullWidth: { default: false } },
    parseMarkdown: {
      match: baseParse.match,
      // Mirrors the preset's own runner (it tags the first row as the header
      // and pushes the column alignment down), plus the `fullWidth` attribute
      // the remark transform left on the mdast node.
      runner: (state: ParserState, node: MarkdownNode, type: NodeType) => {
        const align = node.align;
        const children = (node.children ?? []).map((child, i) => ({
          ...child,
          align,
          isHeader: i === 0,
        }));
        state.openNode(type, { fullWidth: node.fullWidth === true });
        state.next(children);
        state.closeNode();
      },
    },
    toMarkdown: {
      match: baseSerialize.match,
      runner: (state: SerializerState, node: ProseNode) => {
        if (node.attrs.fullWidth) {
          state.addNode("html", undefined, TABLE_FULL_WIDTH_COMMENT);
        }
        baseSerialize.runner(state, node);
      },
    },
  };
});

// ---------------------------------------------------------------------------
// ProseMirror: mirror the attribute onto Crepe's wrapper, and toggle it.
// ---------------------------------------------------------------------------

/**
 * The table at `pos` — which may be the table's own position or any position
 * inside it — or, with no `pos`, the table holding the selection.
 */
export function tableAt(
  state: EditorState,
  pos?: number,
): { pos: number; node: ProseNode } | undefined {
  const at = Math.max(
    0,
    Math.min(
      pos === undefined ? state.selection.from : pos,
      state.doc.content.size,
    ),
  );
  const here = state.doc.nodeAt(at);
  if (here?.type.name === "table") return { pos: at, node: here };
  const $pos = state.doc.resolve(at);
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name === "table") return { pos: $pos.before(depth), node };
  }
  return undefined;
}

/**
 * Flip the table's `fullWidth` attribute. The payload's `pos` is any position
 * inside the target table; without one the selection decides.
 */
export const toggleTableFullWidthCommand = $command<
  { pos?: number } | undefined,
  "ToggleTableFullWidth"
>("ToggleTableFullWidth", () => (payload) => (state, dispatch) => {
  const found = tableAt(state, payload?.pos);
  if (!found) return false;
  if (dispatch) {
    const tr = state.tr.setNodeMarkup(found.pos, undefined, {
      ...found.node.attrs,
      fullWidth: !found.node.attrs.fullWidth,
    });
    dispatch(tr);
  }
  return true;
});

const fullWidthKey = new PluginKey("ken-table-full-width");

function decorate(doc: ProseNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "table") return true;
    if (node.attrs.fullWidth) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, { "data-full-width": "true" }),
      );
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/**
 * A node decoration is the one way to reach Crepe's table node view: it owns
 * its own DOM and never looks at the node's attributes, but ProseMirror still
 * applies decoration attributes to a node view's outer element.
 */
export const tableFullWidthDecorations = $prose(
  () =>
    new Plugin<DecorationSet>({
      key: fullWidthKey,
      state: {
        init: (_config, state) => decorate(state.doc),
        apply: (tr, previous) => (tr.docChanged ? decorate(tr.doc) : previous),
      },
      props: {
        decorations: (state) => fullWidthKey.getState(state),
      },
    }),
);

// ---------------------------------------------------------------------------
// The hover toggle
// ---------------------------------------------------------------------------

/** Class of the button injected into every table block. */
export const TABLE_WIDTH_TOGGLE_CLASS = "ken-table-width-toggle";

const icon = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const EXPAND_ICON = icon(
  '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/>',
);
const SHRINK_ICON = icon(
  '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" x2="21" y1="10" y2="3"/><line x1="3" x2="10" y1="21" y2="14"/>',
);

/** Document position of the table Crepe rendered into `block`. */
function posOfTableBlock(view: EditorView, block: Element): number | undefined {
  let found: number | undefined;
  view.state.doc.descendants((node, pos) => {
    if (found !== undefined) return false;
    if (node.type.name !== "table") return true;
    if (view.nodeDOM(pos) === block) found = pos;
    return false;
  });
  return found;
}

/**
 * Hang a width toggle off each table block. Crepe's node view owns that DOM,
 * but it ignores mutations outside its content element, so an extra
 * non-editable child is safe — and it is the only way to place the button
 * inside the block so `:hover` can reveal it the way the mermaid tools do.
 */
export const tableFullWidthToggle = $prose(
  () =>
    new Plugin({
      key: new PluginKey("ken-table-full-width-toggle"),
      view: (view) => {
        const toggle = (block: Element) => {
          const pos = posOfTableBlock(view, block);
          if (pos === undefined) return;
          const node = view.state.doc.nodeAt(pos);
          if (!node) return;
          view.dispatch(
            view.state.tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              fullWidth: !node.attrs.fullWidth,
            }),
          );
        };

        const sync = () => {
          const blocks = view.dom.querySelectorAll(".milkdown-table-block");
          for (const block of blocks) {
            const existing = block.querySelector(
              `:scope > .${TABLE_WIDTH_TOGGLE_CLASS}`,
            );
            let button: HTMLButtonElement;
            if (existing instanceof HTMLButtonElement) {
              button = existing;
            } else {
              button = document.createElement("button");
              button.type = "button";
              button.className = TABLE_WIDTH_TOGGLE_CLASS;
              button.contentEditable = "false";
              // The node view stops mousedown on buttons for us; preventing
              // the default keeps the caret where it was all the same.
              button.addEventListener("mousedown", (e) => e.preventDefault());
              button.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                toggle(block);
              });
              block.appendChild(button);
            }
            const full = block.getAttribute("data-full-width") === "true";
            const label = full ? "Fit table to text column" : "Expand table to full width";
            button.title = label;
            button.setAttribute("aria-label", label);
            button.innerHTML = full ? SHRINK_ICON : EXPAND_ICON;
          }
        };

        // The node views mount a tick after the view does.
        const raf = requestAnimationFrame(sync);
        return {
          update: sync,
          destroy: () => cancelAnimationFrame(raf),
        };
      },
    }),
);

/** Everything full-width tables need, ready for `editor.use(...)`. */
export const tableFullWidthPlugins = [
  remarkTableFullWidthPlugin,
  fullWidthTableSchema,
  toggleTableFullWidthCommand,
  tableFullWidthDecorations,
  tableFullWidthToggle,
].flat();
