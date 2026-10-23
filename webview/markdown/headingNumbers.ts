/**
 * Heading numbers (`kenMarkdown.headingNumbers.*`): a small, muted "1.a"
 * hanging in the left margin of each top-level heading, and the same label
 * before each table-of-contents entry.
 *
 * Display only. The label is a node decoration (a class, a data attribute and
 * a CSS variable on the heading) that the stylesheet draws as `::before`
 * content, so it is never part of the document, the Markdown, the undo
 * history or a collaboration update, can't be selected or edited, and the
 * caret can't land in it. The counting rules live in `src/headingNumbers.ts`.
 *
 * Only headings that are direct children of the document count: one inside a
 * blockquote, an alert, a list or a table is neither numbered nor counted.
 *
 * The label hangs outside the text column, so heading text never shifts. When
 * the pane is too narrow for that (the gutter can't hold the widest label and
 * the heading's copy-link button), the view switches every label to sit inline
 * before the heading text instead.
 */
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

import { headingNumberLabels, type HeadingNumbersConfig } from "../../src/headingNumbers";
import { collectHeadings } from "./anchors";
import { findTocList } from "./toc";

/** On every numbered heading (and table-of-contents entry). */
export const HEADING_NUMBERED_CLASS = "ken-heading-numbered";
/** The label, drawn by the stylesheet. */
export const HEADING_NUMBER_ATTR = "data-heading-number";
/** On the editor when labels sit inline because the gutter is too narrow. */
export const HEADING_NUMBERS_INLINE_CLASS = "ken-heading-numbers-inline";

const key = new PluginKey<DecorationSet>("ken-heading-numbers");

/** Re-read the config (after a settings change) and redraw the labels. */
export function refreshHeadingNumbers(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(key, true));
}

/** Label of each top-level heading, by position. */
function topLevelLabels(doc: ProseNode, config: HeadingNumbersConfig): Map<number, string> {
  const headings: { pos: number; level: number }[] = [];
  doc.forEach((node, pos) => {
    if (node.type.name === "heading") headings.push({ pos, level: Number(node.attrs.level) || 1 });
  });
  const labels = headingNumberLabels(
    headings.map((h) => h.level),
    config,
  );
  const out = new Map<number, string>();
  headings.forEach((h, i) => {
    const label = labels[i];
    if (label) out.set(h.pos, label);
  });
  return out;
}

const attrs = (label: string) => ({
  class: HEADING_NUMBERED_CLASS,
  [HEADING_NUMBER_ATTR]: label,
  // The label's length, so the copy-link button can clear it (styles.css).
  style: `--ken-heading-number-chars: ${label.length}`,
});

/**
 * The table of contents lists, in order, the non-empty headings after it
 * (toc.ts), nested or not, so its items walked depth first line up with them.
 */
function tocDecorations(doc: ProseNode, labels: Map<number, string>, out: Decoration[]): void {
  const toc = findTocList(doc);
  if (!toc) return;
  const end = toc.pos + toc.node.nodeSize;
  const headings = collectHeadings(doc).filter((h) => h.pos >= end && h.text.trim());
  let index = 0;
  const walk = (list: ProseNode, listPos: number) => {
    list.forEach((item, offset) => {
      const itemPos = listPos + 1 + offset;
      item.forEach((child, childOffset) => {
        const childPos = itemPos + 1 + childOffset;
        if (child.type.name === "paragraph" && childOffset === 0) {
          const heading = headings[index++];
          const label = heading ? labels.get(heading.pos) : undefined;
          if (label) out.push(Decoration.node(childPos, childPos + child.nodeSize, attrs(label)));
        } else if (child.type.name === "bullet_list") {
          walk(child, childPos);
        }
      });
    });
  };
  walk(toc.node, toc.pos);
}

function build(doc: ProseNode, config: HeadingNumbersConfig | undefined): DecorationSet {
  if (!config?.enabled) return DecorationSet.empty;
  const labels = topLevelLabels(doc, config);
  const decorations: Decoration[] = [];
  doc.forEach((node, pos) => {
    const label = labels.get(pos);
    if (label) decorations.push(Decoration.node(pos, pos + node.nodeSize, attrs(label)));
  });
  tocDecorations(doc, labels, decorations);
  return DecorationSet.create(doc, decorations);
}

/**
 * Room the hanging labels need left of the text, in px: the widest label
 * (estimated from its length; the stylesheet sets it at 0.8× the body size
 * with tabular figures), the gap to the text, and the copy-link button.
 */
function neededGutter(view: EditorView): number {
  let chars = 0;
  for (const el of view.dom.querySelectorAll<HTMLElement>(`:scope > .${HEADING_NUMBERED_CLASS}`)) {
    chars = Math.max(chars, el.getAttribute(HEADING_NUMBER_ATTR)?.length ?? 0);
  }
  if (chars === 0) return 0;
  const body = parseFloat(getComputedStyle(view.dom).fontSize) || 16;
  return chars * 0.62 * body * 0.8 + 14 + 22 + 8;
}

/** Labels hang in the gutter when it is wide enough, else sit inline. */
function layout(view: EditorView): void {
  const scroller = view.dom.closest(".editor-scroll") ?? document.documentElement;
  const gutter = view.dom.getBoundingClientRect().left - scroller.getBoundingClientRect().left;
  const needed = neededGutter(view);
  view.dom.classList.toggle(HEADING_NUMBERS_INLINE_CLASS, needed > 0 && gutter < needed);
}

/** Heading numbers, read from `config()` at each rebuild. */
export function headingNumbersPlugin(config: () => HeadingNumbersConfig | undefined = () => undefined) {
  return $prose(
    () =>
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_config, state) => build(state.doc, config()),
          apply: (tr, previous) => (tr.docChanged || tr.getMeta(key) ? build(tr.doc, config()) : previous),
        },
        props: {
          decorations: (state) => key.getState(state),
        },
        view: (view) => {
          let frame = 0;
          const schedule = () => {
            if (frame) return;
            frame = requestAnimationFrame(() => {
              frame = 0;
              if (!view.isDestroyed) layout(view);
            });
          };
          // The pane, not just the text column: past the column's max width
          // only the pane (and so the gutter) grows.
          const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : undefined;
          observer?.observe(view.dom);
          const scroller = view.dom.closest(".editor-scroll");
          if (scroller) observer?.observe(scroller);
          window.addEventListener("resize", schedule);
          schedule();
          return {
            update: (_view, previous) => {
              if (key.getState(view.state) !== key.getState(previous)) schedule();
            },
            destroy: () => {
              if (frame) cancelAnimationFrame(frame);
              observer?.disconnect();
              window.removeEventListener("resize", schedule);
            },
          };
        },
      }),
  );
}
