// The diff view: two versions of a Markdown document, rendered the way the
// editor shows them, with what was added in green and what was removed in
// red. "Combined" is the newer document, editable, with the removed blocks
// shown where they were; "split" is both documents side by side, each
// editable unless the host says it can't be written (a version in git).
// Edits go to the host (src/diffPanel.ts), which writes them to the documents;
// the highlights follow every edit.
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx, parserCtx, serializerCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
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
import { joinDocument, splitDocument } from "./frontmatterModel";
import { splitThreads } from "./comments/store";
import { removedWidgets } from "./diffDom";
import { combinedWidgets, diffBlocks, layoutDiff, syncedScrollTop, type DiffMark, type RemovedWidget } from "./diffModel";
import { normalizeTrailingNewlines } from "./markdown/gfmFidelity";
import { applyTypography, trackScreenHeight } from "./theme";
import { isHostMessage } from "./hostMessage";
import { COMMANDS, command, execute, setClipboardReader, setExportHandler, setPrintHandler, setShortcutLabels } from "./commands";
import { inEditorText, installKeyRouting, setBoundKeys } from "./keys";
import { scrollQuickly } from "./smoothScroll";
import { printableColumns, type PrintColumn } from "./print";
import { collectExportAssets } from "./exportAssets";
import type { DiffContent, DiffHostMessage, DiffLayoutMode, DiffReadOnly, DiffSideName, DiffWebviewMessage, HostMessage } from "../src/protocol";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();
const post = (m: DiffWebviewMessage) => vscode.postMessage(m);

trackScreenHeight();

// --- Highlights ----------------------------------------------------------------

interface Highlights {
  marks: DiffMark[];
  widgets: RemovedWidget[];
  /** Frontmatter (not in the editor), shown above the document when it changed. */
  front: { old: string; new: string; show: DiffSideName[] } | null;
}

const diffKey = new PluginKey<DecorationSet>("ken-diff");

function frontWidget(front: NonNullable<Highlights["front"]>, side: DiffSideName | "combined"): HTMLElement {
  const box = document.createElement("div");
  box.className = "ken-diff-front";
  box.contentEditable = "false";
  const show = side === "combined" ? (["old", "new"] as const) : ([side] as const);
  for (const s of show) {
    if (!front[s]) continue;
    const pre = document.createElement("pre");
    pre.className = s === "old" ? "ken-diff-removed" : "ken-diff-added";
    pre.textContent = front[s];
    box.append(pre);
  }
  return box;
}

function decorations(view: EditorView, h: Highlights, side: DiffSideName | "combined"): DecorationSet {
  const { doc, schema } = view.state;
  const size = doc.content.size;
  const decos: Decoration[] = [];
  for (const m of h.marks) {
    if (m.to > size || m.from >= m.to) continue;
    const attrs: Record<string, string> = {};
    if (m.className) attrs.class = m.className;
    if (m.anchor) attrs["data-diff-anchor"] = m.anchor;
    decos.push(m.block ? Decoration.node(m.from, m.to, attrs) : Decoration.inline(m.from, m.to, attrs));
  }
  decos.push(...removedWidgets(view, h.widgets, "rm", [diffKey]));
  if (h.front && h.front.show.length) {
    decos.push(Decoration.widget(0, () => frontWidget(h.front!, side), { side: -10, key: `front-${h.front.old.length}-${h.front.new.length}` }));
  }
  return DecorationSet.create(doc, decos);
}

// --- Page -------------------------------------------------------------------------

const bar = document.createElement("header");
bar.className = "ken-diff-bar";
const toolbars = document.createElement("div");
toolbars.className = "ken-diff-toolbars";

function button(label: string, tip: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = tip;
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", onClick);
  return b;
}

const combinedBtn = button("Combined", "Both versions in one column", () => setLayout("combined"));
const splitBtn = button("Split", "The two versions side by side", () => setLayout("split"));
const textBtn = button("Switch to Text", "Compare the Markdown source in VS Code's diff editor", () => post({ type: "openTextDiff" }));
const controls = document.createElement("span");
controls.className = "ken-diff-controls";
const toggle = document.createElement("span");
toggle.className = "ken-diff-toggle";
toggle.append(combinedBtn, splitBtn);
const prevBtn = button("↑", "Previous change", () => goToChange(-1));
const nextBtn = button("↓", "Next change", () => goToChange(1));
const nav = document.createElement("span");
nav.className = "ken-diff-nav";
nav.append(prevBtn, nextBtn);
controls.append(nav, toggle, textBtn);
bar.append(toolbars, controls);

const panes = document.createElement("div");
panes.className = "ken-diff-panes";
/** "This file was added/deleted": a file with only one version is shown as it is. */
const banner = document.createElement("div");
banner.className = "ken-diff-banner";
banner.hidden = true;
document.body.append(bar, banner, panes);

// --- State --------------------------------------------------------------------------

let layout: DiffLayoutMode = "combined";
let status: DiffContent["status"];
/** What each version is (e.g. "HEAD (abc1234)", "Working Tree"), and the page's title. */
let labels: Record<DiffSideName, string> = { old: "", new: "" };
let title = "Document";
function setLabels(m: DiffContent) {
  labels = { old: m.oldLabel, new: m.newLabel };
  const name = (m.newLabel || m.oldLabel).replace(/\s*\(.*\)$/, "");
  title = name.slice(name.lastIndexOf("/") + 1).replace(/\.(md|markdown)$/i, "") || "Document";
}
let readOnly: DiffReadOnly = { old: true, new: false };
let base = { old: "", new: "" };
/** Each version's full text: the latest from the host or from an edit here. */
const texts: Record<DiffSideName, string> = { old: "", new: "" };

interface Side {
  role: DiffSideName;
  mode: DiffSideName | "combined";
  crepe: Crepe;
  view: EditorView;
  scroll: HTMLElement;
  toolbar: HTMLElement;
  /** What the editor doesn't hold, put back around its Markdown when saving. */
  front: string;
  gap: string;
  threads: string;
  /** The text this side last showed or produced. */
  shown: string;
  applying: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

let sides: Side[] = [];
let active: Side | null = null;
let renderSeq = 0;

const unescapeWikiLinks = (md: string) => md.replace(/\\\[\\\[([^\n]+?)\\?\]\\?\]/g, "[[$1]]");

function parts(text: string) {
  const { front, gap, body } = splitDocument(text);
  const { body: markdown, block } = splitThreads(body);
  return { front, gap, markdown, threads: block };
}

function serialize(side: Side): string {
  let body = "";
  side.crepe.editor.action((ctx: Ctx) => {
    body = unescapeWikiLinks(normalizeTrailingNewlines(ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc)));
  });
  const withThreads = body + (side.threads ? `${body ? "\n" : ""}${side.threads}` : "");
  return joinDocument(side.front, side.gap, withThreads);
}

function parseIn(side: Side, markdown: string): ProseNode {
  let doc: ProseNode | null = null;
  side.crepe.editor.action((ctx: Ctx) => {
    doc = ctx.get(parserCtx)(markdown) ?? null;
  });
  return doc ?? side.view.state.schema.topNodeType.createAndFill()!;
}

const yaml = (front: string) => front.replace(/^---\r?\n/, "").replace(/\r?\n?---[ \t]*\r?\n?$/, "");

/** Recompute one side's highlights against the other version. */
function highlight(side: Side) {
  if (status) {
    side.view.dispatch(side.view.state.tr.setMeta(diffKey, { marks: [], widgets: [], front: null }).setMeta("addToHistory", false));
    return;
  }
  const other: DiffSideName = side.role === "new" ? "old" : "new";
  const otherDoc = parseIn(side, parts(texts[other]).markdown);
  const doc = side.view.state.doc;
  const entries = side.role === "new" ? diffBlocks(otherDoc, doc) : diffBlocks(doc, otherDoc);
  const h: Highlights = { marks: [], widgets: [], front: null };
  if (side.mode === "combined") {
    h.marks = layoutDiff(entries, "new").marks;
    h.widgets = combinedWidgets(entries);
  } else {
    h.marks = layoutDiff(entries, side.mode).marks;
  }
  const fronts = { old: yaml(parts(texts.old).front), new: yaml(parts(texts.new).front) };
  if (fronts.old !== fronts.new) h.front = { ...fronts, show: side.mode === "combined" ? ["old", "new"] : [side.mode] };
  side.view.dispatch(side.view.state.tr.setMeta(diffKey, h).setMeta("addToHistory", false));
}

function highlightAll() {
  for (const s of sides) highlight(s);
}

/** An edit here: write it (after a pause) and refresh the highlights. */
function edited(side: Side) {
  clearTimeout(side.timer);
  side.timer = setTimeout(() => {
    const text = serialize(side);
    if (text !== side.shown) {
      side.shown = text;
      texts[side.role] = text;
      post({ type: "diffEdit", side: side.role, text });
    }
    highlightAll();
  }, 250);
}

/** Bring a side in line with text changed elsewhere, replacing only what differs. */
function applyText(side: Side, text: string) {
  if (text === side.shown) return;
  side.shown = text;
  const p = parts(text);
  side.front = p.front;
  side.gap = p.gap;
  side.threads = p.threads;
  const next = parseIn(side, p.markdown);
  const { doc } = side.view.state;
  const start = doc.content.findDiffStart(next.content);
  if (start == null) return;
  let { a: endA, b: endB } = doc.content.findDiffEnd(next.content)!;
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  side.applying = true;
  try {
    side.view.dispatch(side.view.state.tr.replace(start, endA, next.slice(start, endB)).setMeta("addToHistory", false));
  } finally {
    side.applying = false;
  }
}

function setActive(side: Side) {
  active = side;
  for (const s of sides) s.toolbar.hidden = s !== side;
  bar.dataset.readonly = String(readOnly[side.role]);
}

function proxyFor(role: DiffSideName) {
  return (src: string) => {
    const root = base[role];
    if (!root || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("#")) return src;
    try {
      return new URL(src, root).toString();
    } catch {
      return src;
    }
  };
}

async function mountSide(role: DiffSideName, mode: Side["mode"]): Promise<Side> {
  const pane = document.createElement("section");
  pane.className = "ken-diff-pane";
  pane.dataset.side = mode;
  pane.dataset.readonly = String(readOnly[role]);
  if (readOnly[role]) {
    const badge = document.createElement("span");
    badge.className = "ken-diff-readonly";
    badge.textContent = "Read-only";
    pane.append(badge);
  }
  const scroll = document.createElement("div");
  scroll.className = "editor-scroll";
  const measure = document.createElement("div");
  measure.className = "measure";
  scroll.append(measure);
  pane.append(scroll);
  panes.append(pane);
  const toolbar = document.createElement("div");
  toolbar.className = "ken-toolbar-host";
  toolbars.append(toolbar);

  const p = parts(texts[role]);
  const crepe = buildEditor({ root: measure, markdown: p.markdown, proxyDomURL: proxyFor(role), onLink: () => true, toolbarHost: toolbar });
  // eslint-disable-next-line prefer-const
  let side: Side;
  crepe.editor.use(
    $prose(
      () =>
        new Plugin<DecorationSet>({
          key: diffKey,
          state: {
            init: () => DecorationSet.empty,
            apply(tr, set) {
              const h = tr.getMeta(diffKey) as Highlights | undefined;
              if (h && side) return decorations(side.view, h, side.mode);
              return set.map(tr.mapping, tr.doc);
            },
          },
          props: { decorations: (state) => diffKey.getState(state) },
          view: () => ({
            update: (v, prev) => {
              if (!side || side.applying || v.state.doc.eq(prev.doc)) return;
              edited(side);
            },
          }),
        }),
    ),
  );
  await crepe.create();
  crepe.setReadonly(readOnly[role]);
  const view = crepe.editor.action((ctx: Ctx) => ctx.get(editorViewCtx));
  side = { role, mode, crepe, view, scroll, toolbar, front: p.front, gap: p.gap, threads: p.threads, shown: texts[role], applying: false };
  pane.addEventListener("focusin", () => setActive(side));
  pane.addEventListener("pointerdown", () => setActive(side));
  return side;
}

async function render() {
  const seq = ++renderSeq;
  const tops = sides.map((s) => s.scroll.scrollTop);
  for (const s of sides) clearTimeout(s.timer);
  for (const s of sides) await s.crepe.destroy();
  if (seq !== renderSeq) return;
  sides = [];
  active = null;
  panes.replaceChildren();
  toolbars.replaceChildren();
  panes.dataset.layout = status ? "combined" : layout;
  combinedBtn.setAttribute("aria-pressed", String(layout === "combined"));
  splitBtn.setAttribute("aria-pressed", String(layout === "split"));
  toggle.hidden = !!status;
  nav.hidden = !!status;
  banner.hidden = !status;
  banner.dataset.status = status ?? "";
  banner.textContent = status === "added" ? "This file was added." : status === "deleted" ? "This file was deleted." : "";
  const only: DiffSideName = status === "deleted" ? "old" : "new";
  const plan: [DiffSideName, Side["mode"]][] = status
    ? [[only, only]]
    : layout === "split"
      ? [["old", "old"], ["new", "new"]]
      : [["new", "combined"]];
  for (const [role, mode] of plan) sides.push(await mountSide(role, mode));
  if (seq !== renderSeq) return;
  setActive(sides.find((s) => s.role === "new") ?? sides[0]!);
  highlightAll();
  sides.forEach((s, i) => (s.scroll.scrollTop = tops[i] ?? tops[0] ?? 0));
  setScrollLeader = () => undefined;
  if (sides.length === 2) linkScrolling(sides[0]!.scroll, sides[1]!.scroll);
  document.body.classList.add("ready");
  // Opened: start at the first change (a layout switch keeps its place).
  if (!opened) {
    opened = true;
    requestAnimationFrame(() => requestAnimationFrame(() => goToChange(1, true)));
  }
}

function setLayout(next: DiffLayoutMode) {
  if (next === layout) return;
  // Unsaved edits go first.
  for (const s of sides) {
    clearTimeout(s.timer);
    const text = serialize(s);
    if (text !== s.shown) {
      texts[s.role] = text;
      post({ type: "diffEdit", side: s.role, text });
    }
  }
  layout = next;
  post({ type: "diffLayout", layout });
  void render();
}

// --- Scrolling: the split panes follow each other, block for block ---------------

/** The anchored blocks of a pane, top to bottom, grouped by anchor: each group's span in the pane's content. */
function anchorSpans(scroll: HTMLElement): { anchor: string; top: number; bottom: number }[] {
  const base = scroll.getBoundingClientRect().top - scroll.scrollTop;
  const spans = new Map<string, { anchor: string; top: number; bottom: number }>();
  for (const el of scroll.querySelectorAll<HTMLElement>("[data-diff-anchor]")) {
    const r = el.getBoundingClientRect();
    const anchor = el.dataset.diffAnchor!;
    const span = spans.get(anchor);
    if (span) {
      span.top = Math.min(span.top, r.top - base);
      span.bottom = Math.max(span.bottom, r.bottom - base);
    } else spans.set(anchor, { anchor, top: r.top - base, bottom: r.bottom - base });
  }
  return [...spans.values()].sort((x, y) => x.top - y.top);
}

/** Set once the view has shown its first change. */
let opened = false;
/** The pane the other follows in split view (linkScrolling). */
let setScrollLeader: (pane: HTMLElement) => void = () => undefined;

const CHANGE = ".ken-diff-added, .ken-diff-removed, .ken-diff-widget, .ken-diff-front";
/** Space left above a change scrolled to. */
const CHANGE_MARGIN = 60;

/** The first element of each run of changed blocks in a pane, top to bottom. */
function changeRuns(scroll: HTMLElement): HTMLElement[] {
  const pm = scroll.querySelector(".ProseMirror");
  if (!pm) return [];
  const runs: HTMLElement[] = [];
  let inRun = false;
  for (const el of Array.from(pm.children) as HTMLElement[]) {
    const changed = el.matches(CHANGE) || el.classList.contains("ken-diff-front");
    if (changed && !inRun) runs.push(el);
    // Widgets ProseMirror adds (cursor wrappers, separators) don't end a run.
    if (el.classList.contains("ProseMirror-widget") && !changed) continue;
    inRun = changed;
  }
  return runs;
}

/**
 * Scroll to the next (1) or previous (-1) run of changes, wrapping around; in
 * split view the pane in use leads and the other follows. `first`: the first
 * change, from the top.
 */
function goToChange(dir: 1 | -1, first = false) {
  const side = (sides.length > 1 ? active : null) ?? sides.find((s) => s.role === "new") ?? sides[0];
  if (!side) return;
  const scroll = side.scroll;
  const base = scroll.getBoundingClientRect().top - scroll.scrollTop;
  const max = scroll.scrollHeight - scroll.clientHeight;
  // A change near the end can only be scrolled to as far as the end goes.
  const tops = [...new Set(changeRuns(scroll).map((el) => Math.min(max, Math.max(0, Math.round(el.getBoundingClientRect().top - base - CHANGE_MARGIN)))))];
  if (!tops.length) return;
  const here = first ? -1 : scroll.scrollTop;
  let top: number;
  if (dir > 0) top = tops.find((t) => t > here + 2) ?? tops[0]!;
  else top = [...tops].reverse().find((t) => t < here - 2) ?? tops[tops.length - 1]!;
  setScrollLeader(scroll);
  if (first) scroll.scrollTop = top;
  else scrollQuickly(scroll, top);
}

/**
 * Scroll the two split panes together. Only the pane the user is working in
 * leads (the last one wheeled, touched, clicked or typed in); the other just
 * follows, so a follower's own scroll events (and a leader's momentum) never
 * echo back and forth.
 */
function linkScrolling(a: HTMLElement, b: HTMLElement) {
  let leader: HTMLElement | null = null;
  setScrollLeader = (pane) => (leader = pane);
  for (const pane of [a, b]) {
    for (const type of ["wheel", "pointerdown", "touchstart", "keydown", "focusin"]) {
      pane.addEventListener(type, () => (leader = pane), { passive: true, capture: true });
    }
  }
  let frame = 0;
  const follow = (from: HTMLElement, to: HTMLElement) => () => {
    if (leader !== from || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const top = syncedScrollTop(from.scrollTop, anchorSpans(from), anchorSpans(to));
      if (top === null) {
        const max = from.scrollHeight - from.clientHeight;
        to.scrollTop = max > 0 ? (from.scrollTop / max) * (to.scrollHeight - to.clientHeight) : 0;
        return;
      }
      if (Math.abs(to.scrollTop - top) >= 1) to.scrollTo({ top, behavior: "instant" });
    });
  };
  a.addEventListener("scroll", follow(a, b), { passive: true });
  b.addEventListener("scroll", follow(b, a), { passive: true });
}

// --- Commands, keys and the host ----------------------------------------------------

installKeyRouting(window, (id) => {
  const cmd = COMMANDS.find((c) => c.id === id);
  const view = active?.view;
  return !!cmd && !!view && view.editable && (cmd.isEnabled ? cmd.isEnabled(view.state) : true);
});

function runCommand(id: string) {
  const side = active;
  if (!side || !side.view.editable) return;
  const cmd = command(id);
  if (cmd.editorOnly && document.activeElement && document.activeElement !== document.body && !inEditorText(document.activeElement)) return;
  side.crepe.editor.action((ctx) => execute(ctx, cmd));
}

let seq = 0;
const waiting = new Map<number, (m: DiffHostMessage) => void>();
setClipboardReader(
  () =>
    new Promise<string>((resolve) => {
      const id = ++seq;
      waiting.set(id, (m) => resolve(m.type === "clipboardText" ? m.text : ""));
      post({ type: "readClipboard", id });
    }),
);
/** The page as the view shows it: one column, or both versions side by side, changes marked. */
function page(autoPrint: boolean): Promise<string> {
  const columns: PrintColumn[] = sides.map((s) => ({
    content: s.scroll.querySelector<HTMLElement>(".measure")!,
    view: s.view,
    wrap: { className: "ken-diff-pane", attrs: { "data-side": s.mode } },
    label: sides.length > 1 ? labels[s.role] : undefined,
  }));
  return printableColumns(columns, title, document, autoPrint);
}

setPrintHandler(() => {
  void page(true).then(
    (html) => post({ type: "print", html, name: title }),
    (err) => post({ type: "error", message: `print: ${err}` }),
  );
});
setExportHandler(() => post({ type: "export" }));

function onContent(m: DiffContent) {
  setLabels(m);
  if (m.status !== status) {
    // Now new or gone, or back to two versions: redraw.
    status = m.status;
    texts.old = m.oldText;
    texts.new = m.newText;
    void render();
    return;
  }
  for (const role of ["old", "new"] as const) {
    texts[role] = m[`${role}Text`];
    for (const s of sides) if (s.role === role) applyText(s, texts[role]);
  }
  highlightAll();
}

window.addEventListener("message", (event: MessageEvent<DiffHostMessage | HostMessage>) => {
  if (!isHostMessage(event, window)) return;
  const m = event.data as DiffHostMessage;
  if (!m || typeof m !== "object") return;
  try {
    switch (m.type) {
      case "diffInit":
        applyTypography(m.config);
        document.body.dataset.toolbar = "top";
        layout = m.layout;
        base = m.base;
        readOnly = m.readOnly;
        setShortcutLabels(m.shortcuts ?? {});
        setBoundKeys(m.keys ?? {});
        texts.old = m.oldText;
        texts.new = m.newText;
        status = m.status;
        setLabels(m);
        void render();
        return;
      case "diffUpdate":
        onContent(m);
        return;
      case "config":
        applyTypography(m.config);
        return;
      case "command":
        runCommand(m.id);
        return;
      case "shortcuts":
        setShortcutLabels(m.labels);
        setBoundKeys(m.keys ?? {});
        return;
      case "clipboardText":
        waiting.get(m.id)?.(m);
        waiting.delete(m.id);
        return;
      case "test":
        post({ type: "testResult", id: m.id, result: m.selectors.map((s) => document.querySelectorAll(s).length) });
        return;
      case "exportPage":
        void page(false).then(
          (html) => post({ type: "exportPageReady", id: m.id, html }),
          (err) => {
            post({ type: "error", message: `export: ${err}` });
            post({ type: "exportPageReady", id: m.id, html: "" });
          },
        );
        return;
      case "exportAssets": {
        // The newer version's pictures, from a side that shows it (or the version's own document).
        const side = sides.find((s) => s.role === m.side);
        const doc = side ? side.view.state.doc : parseIn(sides[0]!, parts(texts[m.side]).markdown);
        void collectExportAssets(doc, proxyFor(m.side)).then(
          ({ images, diagrams }) => post({ type: "exportAssetsReady", id: m.id, images, diagrams }),
          (err) => {
            post({ type: "error", message: `export: ${err}` });
            post({ type: "exportAssetsReady", id: m.id, images: {}, diagrams: [] });
          },
        );
        return;
      }
    }
  } catch (err) {
    post({ type: "error", message: String(err) });
  }
});

window.addEventListener("focus", () => post({ type: "focus", focused: true }));
window.addEventListener("blur", () => {
  post({ type: "focus", focused: false });
  // Leaving the view writes what was typed.
  for (const s of sides) {
    clearTimeout(s.timer);
    const text = serialize(s);
    if (text !== s.shown) {
      s.shown = text;
      texts[s.role] = text;
      post({ type: "diffEdit", side: s.role, text });
    }
  }
});
window.addEventListener("error", (e) => post({ type: "error", message: String(e.message) }));
if (document.hasFocus()) post({ type: "focus", focused: true });
post({ type: "diffReady" });
