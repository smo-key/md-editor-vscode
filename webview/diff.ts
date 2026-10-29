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
import { DOMSerializer, type Node as ProseNode } from "@milkdown/kit/prose/model";
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
import { combinedWidgets, diffBlocks, layoutDiff, type DiffMark, type RemovedWidget } from "./diffModel";
import { normalizeTrailingNewlines } from "./markdown/gfmFidelity";
import { applyTypography, trackScreenHeight } from "./theme";
import { isHostMessage } from "./hostMessage";
import { COMMANDS, command, execute, setClipboardReader, setPrintHandler, setShortcutLabels } from "./commands";
import { inEditorText, installKeyRouting, setBoundKeys } from "./keys";
import { printablePage } from "./print";
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

/** Wrap the text between offsets `[from, to)` of `root`'s text in spans of `className`. */
function highlightText(root: HTMLElement, ranges: [number, number][], className: string) {
  if (!ranges.length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
  let offset = 0;
  for (const text of texts) {
    const start = offset;
    const end = offset + text.data.length;
    offset = end;
    const hits = ranges.filter(([a, b]) => a < end && b > start).map(([a, b]) => [Math.max(a, start) - start, Math.min(b, end) - start]);
    for (const [a, b] of hits.reverse()) {
      const target = text.splitText(a);
      target.splitText(b - a);
      const span = document.createElement("span");
      span.className = className;
      target.replaceWith(span);
      span.append(target);
    }
  }
}

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
  const serializer = DOMSerializer.fromSchema(schema);
  h.widgets.forEach((w, i) => {
    const pos = Math.min(w.pos, size);
    decos.push(
      Decoration.widget(
        pos,
        () => {
          const box = document.createElement("div");
          box.className = `ken-diff-removed ken-diff-widget${w.entry.pair ? " ken-diff-edited" : ""}`;
          box.contentEditable = "false";
          box.append(serializer.serializeNode(w.entry.node));
          highlightText(box, w.words, "ken-diff-removed-text");
          return box;
        },
        { side: -1, key: `rm-${i}-${w.entry.node.textContent.length}-${w.entry.node.type.name}`, ignoreSelection: true },
      ),
    );
  });
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
controls.append(toggle, textBtn);
bar.append(toolbars, controls);

const panes = document.createElement("div");
panes.className = "ken-diff-panes";
document.body.append(bar, panes);

// --- State --------------------------------------------------------------------------

let layout: DiffLayoutMode = "combined";
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
  panes.dataset.layout = layout;
  combinedBtn.setAttribute("aria-pressed", String(layout === "combined"));
  splitBtn.setAttribute("aria-pressed", String(layout === "split"));
  const plan: [DiffSideName, Side["mode"]][] = layout === "split" ? [["old", "old"], ["new", "new"]] : [["new", "combined"]];
  for (const [role, mode] of plan) sides.push(await mountSide(role, mode));
  if (seq !== renderSeq) return;
  setActive(sides.find((s) => s.role === "new") ?? sides[0]!);
  highlightAll();
  sides.forEach((s, i) => (s.scroll.scrollTop = tops[i] ?? tops[0] ?? 0));
  if (sides.length === 2) linkScrolling(sides[0]!.scroll, sides[1]!.scroll);
  document.body.classList.add("ready");
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
setPrintHandler(() => {
  const side = active;
  if (!side) return;
  void printablePage(side.scroll.querySelector<HTMLElement>(".measure")!, "Document").then((html) => post({ type: "print", html, name: "Document" }));
});

function onContent(m: DiffContent) {
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
