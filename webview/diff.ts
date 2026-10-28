// The diff view: a Markdown file's changes (e.g. since the last commit),
// rendered the way the editor shows the document, with what was added in
// green and what was removed in red. Either both versions interleaved in one
// column ("combined"), or side by side ("split"), scrolled together.
// Read-only; the host (src/diffPanel.ts) supplies both texts and refreshes them.
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx, parserCtx } from "@milkdown/kit/core";
import type { Node as ProseNode, Schema } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

import "@fontsource/newsreader/400.css";
import "@fontsource/newsreader/500.css";
import "@fontsource/newsreader/400-italic.css";
import "@fontsource/hanken-grotesk/400.css";
import "@fontsource/hanken-grotesk/500.css";
import "@fontsource/hanken-grotesk/600.css";
import "@fontsource/hanken-grotesk/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@milkdown/crepe/theme/common/style.css";
import "katex/dist/katex.min.css";
import "@milkdown/crepe/theme/frame.css";
import "./markdown/githubAlert.css";
import "./styles.css";
import "./diff.css";

import { buildEditor } from "./editorSetup";
import { splitDocument } from "./frontmatterModel";
import { splitThreads } from "./comments/store";
import { diffBlocks, layoutDiff, type DiffMark, type DiffSide } from "./diffModel";
import { applyTypography } from "./theme";
import { isHostMessage } from "./hostMessage";
import type { DiffContent, DiffHostMessage, DiffLayoutMode, DiffWebviewMessage } from "../src/protocol";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();
const post = (m: DiffWebviewMessage) => vscode.postMessage(m);

const diffKey = new PluginKey<DecorationSet>("ken-diff");

/** Decorations for the marks a transaction carries (meta), mapped otherwise. */
const diffDecorations = $prose(
  () =>
    new Plugin<DecorationSet>({
      key: diffKey,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, set) {
          const marks = tr.getMeta(diffKey) as DiffMark[] | undefined;
          if (!marks) return set.map(tr.mapping, tr.doc);
          const decorations = marks.map((m) => {
            const attrs: Record<string, string> = {};
            if (m.className) attrs.class = m.className;
            if (m.anchor) attrs["data-diff-anchor"] = m.anchor;
            return m.block ? Decoration.node(m.from, m.to, attrs) : Decoration.inline(m.from, m.to, attrs);
          });
          return DecorationSet.create(tr.doc, decorations);
        },
      },
      props: { decorations: (state) => diffKey.getState(state) },
    }),
);

// --- Page ---------------------------------------------------------------------

const bar = document.createElement("header");
bar.className = "ken-diff-bar";
const title = document.createElement("span");
title.className = "ken-diff-title";
const stats = document.createElement("span");
stats.className = "ken-diff-stats";
const spacer = document.createElement("span");
spacer.className = "ken-diff-spacer";

function button(label: string, tip: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = tip;
  b.addEventListener("click", onClick);
  return b;
}

const prev = button("↑", "Previous change", () => step(-1));
const next = button("↓", "Next change", () => step(1));
const combinedBtn = button("Combined", "Both versions in one column", () => setLayout("combined"));
const splitBtn = button("Split", "The two versions side by side", () => setLayout("split"));
const openBtn = button("Open file", "Open the file in the editor", () => post({ type: "openFile" }));
const textBtn = button("Text diff", "Compare the Markdown source in VS Code's diff editor", () => post({ type: "openTextDiff" }));
const toggle = document.createElement("span");
toggle.className = "ken-diff-toggle";
toggle.append(combinedBtn, splitBtn);
bar.append(title, stats, spacer, prev, next, toggle, textBtn, openBtn);

const panes = document.createElement("div");
panes.className = "ken-diff-panes";
document.body.append(bar, panes);

let layout: DiffLayoutMode = "combined";
let content: DiffContent | null = null;
let base = "";
let editors: Crepe[] = [];
let scrollers: HTMLElement[] = [];
let renderSeq = 0;

function proxy(src: string): string {
  if (!base || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("#")) return src;
  try {
    return new URL(src, base).toString();
  } catch {
    return src;
  }
}

/** A version as one document: its frontmatter (as a YAML code block) and body, comments block left out. */
function parseVersion(text: string, parse: (md: string) => ProseNode, schema: Schema): ProseNode {
  const { front, body } = splitDocument(text);
  const doc = parse(splitThreads(body).body);
  if (!front) return doc;
  const yaml = front.replace(/^---\r?\n/, "").replace(/\r?\n?---[ \t]*\r?\n?$/, "");
  const code = schema.nodes.code_block!.create({ language: "yaml" }, yaml ? schema.text(yaml) : null);
  const nodes: ProseNode[] = [code];
  doc.forEach((n) => nodes.push(n));
  return schema.topNodeType.create(null, nodes);
}

async function mountSide(side: DiffSide, label: string | null, data: DiffContent): Promise<{ added: number; removed: number; edited: number }> {
  const pane = document.createElement("section");
  pane.className = "ken-diff-pane";
  pane.dataset.side = side;
  if (label) {
    const head = document.createElement("div");
    head.className = "ken-diff-pane-label";
    head.textContent = label;
    pane.append(head);
  }
  const scroll = document.createElement("div");
  scroll.className = "editor-scroll";
  const measure = document.createElement("div");
  measure.className = "measure";
  scroll.append(measure);
  pane.append(scroll);
  panes.append(pane);
  scrollers.push(scroll);

  const crepe = buildEditor({ root: measure, markdown: "", proxyDomURL: proxy, onLink: () => true });
  crepe.editor.use(diffDecorations);
  await crepe.create();
  crepe.setReadonly(true);
  editors.push(crepe);
  let counts = { added: 0, removed: 0, edited: 0 };
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const parser = ctx.get(parserCtx);
    const { schema } = view.state;
    const parse = (md: string) => parser(md) ?? schema.topNodeType.createAndFill()!;
    const entries = diffBlocks(parseVersion(data.oldText, parse, schema), parseVersion(data.newText, parse, schema));
    const result = layoutDiff(entries, side);
    counts = { added: result.added, removed: result.removed, edited: result.edited };
    const nodes = result.nodes.length ? result.nodes : [schema.nodes.paragraph!.create()];
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, nodes);
    tr.setMeta(diffKey, result.marks).setMeta("addToHistory", false);
    view.dispatch(tr);
  });
  return counts;
}

async function render() {
  if (!content) return;
  const seq = ++renderSeq;
  const tops = scrollers.map((s) => s.scrollTop);
  for (const e of editors) await e.destroy();
  if (seq !== renderSeq) return;
  editors = [];
  scrollers = [];
  panes.replaceChildren();
  panes.dataset.layout = layout;
  combinedBtn.setAttribute("aria-pressed", String(layout === "combined"));
  splitBtn.setAttribute("aria-pressed", String(layout === "split"));
  title.textContent = `${content.oldLabel} ↔ ${content.newLabel}`;
  const sides: [DiffSide, string | null][] =
    layout === "split" ? [["old", content.oldLabel], ["new", content.newLabel]] : [["combined", null]];
  let counts = { added: 0, removed: 0, edited: 0 };
  for (const [side, label] of sides) counts = await mountSide(side, label, content);
  if (seq !== renderSeq) return;
  const parts = [
    counts.edited && `${counts.edited} changed`,
    counts.added && `${counts.added} added`,
    counts.removed && `${counts.removed} removed`,
  ].filter(Boolean);
  stats.textContent = parts.length ? `${parts.join(", ")} (blocks)` : "No changes";
  stats.dataset.empty = String(!parts.length);
  scrollers.forEach((s, i) => (s.scrollTop = tops[i] ?? tops[0] ?? 0));
  if (scrollers.length === 2) linkScrolling(scrollers[0]!, scrollers[1]!);
  document.body.classList.add("ready");
}

function setLayout(next: DiffLayoutMode) {
  if (next === layout) return;
  layout = next;
  post({ type: "diffLayout", layout });
  void render();
}

// --- Scrolling: the split panes follow each other, block for block ---------------

function anchorAtTop(scroll: HTMLElement): { anchor: string; ratio: number } | null {
  const top = scroll.getBoundingClientRect().top;
  for (const el of scroll.querySelectorAll<HTMLElement>("[data-diff-anchor]")) {
    const r = el.getBoundingClientRect();
    if (r.bottom > top) return { anchor: el.dataset.diffAnchor!, ratio: r.height ? (top - r.top) / r.height : 0 };
  }
  return null;
}

function linkScrolling(a: HTMLElement, b: HTMLElement) {
  let driver: HTMLElement | null = null;
  const follow = (from: HTMLElement, to: HTMLElement) => () => {
    if (driver && driver !== from) return;
    driver = from;
    requestAnimationFrame(() => (driver = null));
    const at = anchorAtTop(from);
    const target = at && to.querySelector<HTMLElement>(`[data-diff-anchor="${at.anchor}"]`);
    if (!at || !target) {
      // A run of changes only one side has: keep proportion instead.
      const max = from.scrollHeight - from.clientHeight;
      to.scrollTop = max > 0 ? (from.scrollTop / max) * (to.scrollHeight - to.clientHeight) : 0;
      return;
    }
    const r = target.getBoundingClientRect();
    to.scrollTop += r.top + at.ratio * r.height - to.getBoundingClientRect().top;
  };
  a.addEventListener("scroll", follow(a, b), { passive: true });
  b.addEventListener("scroll", follow(b, a), { passive: true });
}

/** Scroll to the previous or next run of changes. */
function step(dir: -1 | 1) {
  const scroll = scrollers[scrollers.length - 1];
  if (!scroll) return;
  // Every run of changes, by anchor, in either pane (a run may be on one side only).
  const seen = new Map<string, HTMLElement>();
  for (const s of scrollers) {
    for (const el of s.querySelectorAll<HTMLElement>('[data-diff-anchor^="c"]')) {
      const a = el.dataset.diffAnchor!;
      if (!seen.has(a)) seen.set(a, el);
    }
  }
  const runs = [...seen.entries()].sort((x, y) => Number(x[0].slice(1)) - Number(y[0].slice(1)));
  if (!runs.length) return;
  const paneTop = (el: HTMLElement) => el.getBoundingClientRect().top - el.closest(".editor-scroll")!.getBoundingClientRect().top;
  const target =
    dir > 0 ? runs.find(([, el]) => paneTop(el) > 8) : [...runs].reverse().find(([, el]) => paneTop(el) < -8);
  if (!target) return;
  const [, el] = target;
  const owner = el.closest<HTMLElement>(".editor-scroll")!;
  owner.scrollTop += paneTop(el) - 24;
}

window.addEventListener("keydown", (e) => {
  if (e.altKey && (e.key === "F5" || e.key === "ArrowDown")) step(1);
  else if (e.altKey && e.key === "ArrowUp") step(-1);
  else return;
  e.preventDefault();
});

window.addEventListener("message", (event: MessageEvent<DiffHostMessage>) => {
  if (!isHostMessage(event, window)) return;
  const m = event.data;
  if (!m || typeof m !== "object") return;
  try {
    switch (m.type) {
      case "diffInit":
        applyTypography(m.config);
        layout = m.layout;
        base = m.base;
        content = m;
        void render();
        return;
      case "diffUpdate":
        content = m;
        void render();
        return;
      case "config":
        applyTypography(m.config);
        return;
    }
  } catch (err) {
    post({ type: "error", message: String(err) });
  }
});

window.addEventListener("error", (e) => post({ type: "error", message: String(e.message) }));
post({ type: "diffReady" });
