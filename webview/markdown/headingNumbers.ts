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
 * The label hangs outside the text column, right-aligned to end a fixed gap
 * before it, so heading text never shifts. When the pane is too narrow for the
 * widest label, the whole column pads its left side just enough (see
 * `layout`) rather than pushing headings alone.
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
/** On the text column (`.measure`) when it pads its left side to make room for the labels. */
export const HEADING_NUMBERS_RESERVE_CLASS = "ken-heading-numbers-reserve";

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

/** The width of the widest label, as the stylesheet draws it. */
function widestLabel(view: EditorView): number {
  const headings = [...view.dom.querySelectorAll<HTMLElement>(`:scope > .${HEADING_NUMBERED_CLASS}`)];
  if (!headings.length) return 0;
  const longest = headings.reduce((a, b) =>
    (b.getAttribute(HEADING_NUMBER_ATTR)?.length ?? 0) > (a.getAttribute(HEADING_NUMBER_ATTR)?.length ?? 0) ? b : a,
  );
  // A probe in the label's own font: the `::before` box itself is zero-width.
  const style = getComputedStyle(longest, "::before");
  const probe = document.createElement("span");
  probe.textContent = longest.getAttribute(HEADING_NUMBER_ATTR) ?? "";
  Object.assign(probe.style, {
    position: "absolute",
    visibility: "hidden",
    whiteSpace: "nowrap",
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    fontVariantNumeric: style.fontVariantNumeric,
    letterSpacing: style.letterSpacing,
  });
  document.body.append(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
}

/** Sets the column's extra left padding; 0 removes it. */
function setReserve(column: HTMLElement, px: number): void {
  column.classList.toggle(HEADING_NUMBERS_RESERVE_CLASS, px > 0);
  if (px > 0) column.style.setProperty("--ken-heading-number-reserve", `${px}px`);
  else column.style.removeProperty("--ken-heading-number-reserve");
}

/**
 * Labels always hang left of the text column. When the pane leaves too little
 * room left of the column for the widest label, the whole column (the
 * Properties panel included) gets just enough extra left padding, so every
 * block moves together and headings stay flush with the text below them.
 */
function layout(view: EditorView): void {
  const column = view.dom.closest<HTMLElement>(".measure");
  if (!column) return;
  const label = widestLabel(view);
  if (label === 0) return setReserve(column, 0);
  const scroller = view.dom.closest(".editor-scroll") ?? document.documentElement;
  const gap = parseFloat(getComputedStyle(view.dom).getPropertyValue("--ken-heading-number-gap")) || 14;
  // Label, gap to the text, and a few px clear of the pane's edge.
  const needed = label + gap + 4;
  const room = () => view.dom.getBoundingClientRect().left - scroller.getBoundingClientRect().left;
  setReserve(column, 0);
  // The padding moves the text by up to its own amount (a centred column moves
  // less), so close the shortfall in a few steps.
  let reserve = 0;
  for (let i = 0; i < 4; i++) {
    const short = needed - room();
    if (short <= 0.5) break;
    reserve = Math.ceil(reserve + short);
    setReserve(column, reserve);
  }
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
              const column = view.dom.closest<HTMLElement>(".measure");
              if (column) setReserve(column, 0);
              observer?.disconnect();
              window.removeEventListener("resize", schedule);
            },
          };
        },
      }),
  );
}
