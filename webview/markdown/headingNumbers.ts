/**
 * Heading numbers (`kenMarkdown.headingNumbers.*`): a muted "1.a" inline
 * before the text of each top-level heading, and the same label before each
 * table-of-contents entry.
 *
 * Display only. The label is a node decoration (a class and a data attribute
 * on the heading) that the stylesheet draws as inline `::before` content, so
 * it pushes the heading text right but is never part of the document, the
 * Markdown, the undo history, the clipboard or a collaboration update. It
 * can't be selected or edited, and the caret can't land in it: no document
 * position moves and there is no DOM node, so arrows, Home/End, clicks and
 * Backspace at the heading start behave as without it. (An uneditable widget
 * would be a DOM node, and Chrome's Home then puts the caret before it, which
 * resolves to the end of the previous block.) The decoration only changes
 * when a label does, so nothing flickers while you type. The counting rules
 * live in `src/headingNumbers.ts`.
 *
 * Only headings that are direct children of the document count: one inside a
 * blockquote, an alert, a list or a table is neither numbered nor counted.
 */
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { type EditorState, Plugin, PluginKey, type Transaction } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

import { headingNumberLabels, type HeadingNumbersConfig } from "../../src/headingNumbers";
import { collectHeadings } from "./anchors";
import { findTocList } from "./toc";

/** On every numbered heading (and table-of-contents entry). */
export const HEADING_NUMBERED_CLASS = "ken-heading-numbered";
/** The label, drawn by the stylesheet. */
export const HEADING_NUMBER_ATTR = "data-heading-number";

const key = new PluginKey<NumbersState>("ken-heading-numbers");

/** The decorations drawn now (exported for tests). */
export function headingNumberDecorations(state: EditorState): DecorationSet | undefined {
  return key.getState(state)?.set;
}

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

/** A labelled node: a top-level heading or a table-of-contents entry. */
interface Span {
  from: number;
  to: number;
  label: string;
}

/** The plugin's state: the labelled nodes and the decorations drawn from them. */
interface NumbersState {
  spans: Span[];
  set: DecorationSet;
}

const attrs = (label: string) => ({ class: HEADING_NUMBERED_CLASS, [HEADING_NUMBER_ATTR]: label });

/**
 * The table of contents lists, in order, the non-empty headings after it
 * (toc.ts), nested or not, so its items walked depth first line up with them.
 */
function tocSpans(doc: ProseNode, labels: Map<number, string>, out: Span[]): void {
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
          if (label) out.push({ from: childPos, to: childPos + child.nodeSize, label });
        } else if (child.type.name === "bullet_list") {
          walk(child, childPos);
        }
      });
    });
  };
  walk(toc.node, toc.pos);
}

function spansOf(doc: ProseNode, config: HeadingNumbersConfig | undefined): Span[] {
  if (!config?.enabled) return [];
  const labels = topLevelLabels(doc, config);
  const spans: Span[] = [];
  doc.forEach((node, pos) => {
    const label = labels.get(pos);
    if (label) spans.push({ from: pos, to: pos + node.nodeSize, label });
  });
  tocSpans(doc, labels, spans);
  return spans;
}

function build(doc: ProseNode, config: HeadingNumbersConfig | undefined): NumbersState {
  const spans = spansOf(doc, config);
  const set = spans.length
    ? DecorationSet.create(
        doc,
        spans.map((s) => Decoration.node(s.from, s.to, attrs(s.label))),
      )
    : DecorationSet.empty;
  return { spans, set };
}

const sameSpans = (a: Span[], b: Span[]) =>
  a.length === b.length && a.every((s, i) => s.from === b[i]!.from && s.to === b[i]!.to && s.label === b[i]!.label);

/**
 * After an edit: the same labels on the same nodes keep the previous
 * decorations (the very same set when nothing before or inside a labelled
 * node moved, as when typing in a paragraph after it), so ProseMirror redraws
 * nothing. Only a change of heading structure or labels builds a new set.
 */
function apply(tr: Transaction, previous: NumbersState, config: HeadingNumbersConfig | undefined): NumbersState {
  if (tr.getMeta(key)) return build(tr.doc, config);
  if (!tr.docChanged) return previous;
  const spans = spansOf(tr.doc, config);
  const mapped = previous.spans.map((s) => ({ from: tr.mapping.map(s.from, 1), to: tr.mapping.map(s.to, -1), label: s.label }));
  if (!sameSpans(spans, mapped)) return build(tr.doc, config);
  if (sameSpans(spans, previous.spans)) return previous;
  return { spans, set: previous.set.map(tr.mapping, tr.doc) };
}

/** Heading numbers, read from `config()` at each rebuild. */
export function headingNumbersPlugin(config: () => HeadingNumbersConfig | undefined = () => undefined) {
  return $prose(
    () =>
      new Plugin<NumbersState>({
        key,
        state: {
          init: (_config, state) => build(state.doc, config()),
          apply: (tr, previous) => apply(tr, previous, config()),
        },
        props: {
          decorations: (state) => key.getState(state)?.set,
        },
      }),
  );
}
