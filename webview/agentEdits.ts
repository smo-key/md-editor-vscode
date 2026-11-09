// A chat agent's pending edits to the file (VS Code's chat editing: what the
// text editor shows in green and red with Keep and Undo), shown in the editor
// itself: changed blocks in green, removed ones in red where they were, each
// run of changes with its own Keep/Undo, and a bar for the whole file with
// Keep, Undo and the way from change to change. The host (src/agentEditsHost.ts)
// does the keeping and undoing, through VS Code, so the chat stays in step.
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { combinedWidgets, diffBlocks, layoutDiff, type BlockEntry } from "./diffModel";
import { removedWidgets } from "./diffDom";
import { scrollParent, scrollQuickly } from "./smoothScroll";
import "./diff.css";

/** One run of changed blocks, and where it is in the document as it is now. */
export interface AgentHunk {
  /** The added blocks' span; `from === to` when the run only removed blocks. */
  from: number;
  to: number;
  /** The blocks as they were, which undoing the run puts back. */
  removed: ProseNode[];
  /** The frontmatter changed (shown above the document), not blocks. */
  front?: { old: string; new: string };
}

/** The runs of changes between `entries`' two documents, positioned in the newer one. */
export function agentHunks(entries: BlockEntry[]): AgentHunk[] {
  const out: AgentHunk[] = [];
  let pos = 0;
  let open: AgentHunk | null = null;
  for (const entry of entries) {
    if (entry.kind === "same") {
      open = null;
      pos += entry.node.nodeSize;
      continue;
    }
    if (!open) {
      open = { from: pos, to: pos, removed: [] };
      out.push(open);
    }
    if (entry.kind === "removed") open.removed.push(entry.node);
    else {
      pos += entry.node.nodeSize;
      open.to = pos;
    }
  }
  return out;
}

export interface AgentEditsHost {
  /** The editor's Markdown parser (the body only). */
  parse(markdown: string): ProseNode | null;
  /** Split the file's text into its frontmatter (and the blank lines after it) and the body the editor shows. */
  split(text: string): { front: string; gap: string; markdown: string };
  /** The frontmatter as it is now. */
  front(): string;
  /** The whole file as the editor would write it for `doc`, with `head` in place of the current frontmatter. */
  fullText(doc: ProseNode, head?: { front: string; gap: string }): string;
  /** Report unsynced edits to VS Code before acting. */
  flush(): void;
  post(message: { type: "agentAction"; action: "keep" | "undo"; scope: "file" } | { type: "agentAction"; action: "keep" | "undo"; scope: "change"; current: string; reverted: string }): void;
}

interface State {
  decos: DecorationSet;
  hunks: AgentHunk[];
  /** The agent created the file: shown as it is under a banner, kept or undone whole. */
  added?: boolean;
}

const key = new PluginKey<State>("ken-agent-edits");
const yaml = (front: string) => front.replace(/^---\r?\n/, "").replace(/\r?\n?---[ \t]*\r?\n?$/, "");

let host: AgentEditsHost | null = null;
let view: EditorView | null = null;
let original: { front: string; gap: string; doc: ProseNode } | null = null;
let current = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
/** Until when an action is on its way: the buttons wait for the file to change. */
let busyUntil = 0;
const busy = () => Date.now() < busyUntil;

const bar = document.createElement("div");
bar.className = "ken-agent-bar";
bar.hidden = true;

function button(label: string, title: string, run: () => void, className = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = title;
  if (className) b.className = className;
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    run();
  });
  return b;
}

const counter = document.createElement("span");
counter.className = "ken-agent-count";
bar.append(
  button("Keep", "Keep Chat Edits in this File", () => resolveFile("keep"), "primary"),
  button("Undo", "Undo Chat Edits in this File", () => resolveFile("undo")),
  counter,
  button("↑", "Go to Previous Chat Edit", () => step(-1)),
  button("↓", "Go to Next Chat Edit", () => step(1)),
);

/** Printing and exporting show the document as it is, without the agent's changes marked. */
function skipInPrint(el: HTMLElement): HTMLElement {
  el.dataset.print = "skip";
  return el;
}

const isAdded = () => !!view && !!key.getState(view.state)?.added;

function hunks(): AgentHunk[] {
  return view ? (key.getState(view.state)?.hunks ?? []) : [];
}

function actions(index: number): HTMLElement {
  const box = document.createElement("div");
  box.className = "ken-agent-hunk";
  box.contentEditable = "false";
  skipInPrint(box);
  box.dataset.hunk = String(index);
  const inner = document.createElement("div");
  inner.className = "ken-agent-actions";
  inner.append(
    button("Keep", "Keep this Change", () => resolveChange("keep", index), "primary"),
    button("Undo", "Undo this Change", () => resolveChange("undo", index)),
  );
  box.append(inner);
  return box;
}

function frontBox(front: NonNullable<AgentHunk["front"]>): HTMLElement {
  const box = document.createElement("div");
  box.className = "ken-diff-front ken-agent-front";
  box.contentEditable = "false";
  skipInPrint(box);
  for (const [text, className] of [
    [front.old, "ken-diff-removed"],
    [front.new, "ken-diff-added"],
  ] as const) {
    if (!text) continue;
    const pre = document.createElement("pre");
    pre.className = className;
    pre.textContent = text;
    box.append(pre);
  }
  return box;
}

function compute(v: EditorView): State {
  if (!original) return { decos: DecorationSet.empty, hunks: [] };
  const { doc } = v.state;
  if (!original.front && !original.doc.textContent && original.doc.childCount <= 1 && (doc.textContent || host!.front())) {
    const banner = () => {
      const el = document.createElement("div");
      el.className = "ken-diff-banner ken-agent-banner";
      el.dataset.status = "added";
      el.contentEditable = "false";
      el.textContent = "This file was added.";
      return skipInPrint(el);
    };
    return { decos: DecorationSet.create(doc, [Decoration.widget(0, banner, { side: -10, key: "agent-added", ignoreSelection: true })]), hunks: [], added: true };
  }
  const entries = diffBlocks(original.doc, doc);
  const list = agentHunks(entries);
  const fronts = { old: yaml(original.front), new: yaml(host!.front()) };
  if (fronts.old !== fronts.new) list.unshift({ from: 0, to: 0, removed: [], front: fronts });
  const decos: Decoration[] = [];
  const size = doc.content.size;
  for (const m of layoutDiff(entries, "new").marks) {
    if (!m.className || m.to > size || m.from >= m.to) continue;
    const attrs: Record<string, string> = { class: `${m.className} ken-agent-mark` };
    if (m.title) attrs.title = m.title;
    decos.push(m.block ? Decoration.node(m.from, m.to, attrs) : Decoration.inline(m.from, m.to, attrs));
  }
  decos.push(...removedWidgets(v, combinedWidgets(entries), "agent-rm", [key], skipInPrint));
  list.forEach((h, i) => {
    const at = Math.min(h.from, size);
    // The run's Keep/Undo first, over the top of what changed.
    decos.push(Decoration.widget(at, () => actions(i), { side: -3, key: `agent-hunk-${i}-${list.length}`, ignoreSelection: true }));
    if (h.front) decos.push(Decoration.widget(at, () => frontBox(h.front!), { side: -2, key: `agent-front-${h.front.old.length}-${h.front.new.length}`, ignoreSelection: true, stopEvent: () => true }));
  });
  return { decos: DecorationSet.create(doc, decos), hunks: list };
}

function refresh() {
  clearTimeout(timer);
  if (!view) return;
  busyUntil = 0;
  view.dispatch(view.state.tr.setMeta(key, compute(view)).setMeta("addToHistory", false));
  const list = hunks();
  bar.hidden = !agentEdits.pending();
  bar.classList.toggle("added", isAdded());
  if (current >= list.length) current = Math.max(0, list.length - 1);
  showCurrent(false);
}

function showCurrent(scroll: boolean) {
  const list = hunks();
  counter.textContent = list.length ? `${current + 1} of ${list.length}` : "";
  if (!view) return;
  for (const el of view.dom.querySelectorAll<HTMLElement>(".ken-agent-hunk")) {
    el.classList.toggle("current", el.dataset.hunk === String(current));
  }
  const hunk = scroll ? view.dom.querySelector<HTMLElement>(`.ken-agent-hunk[data-hunk="${current}"]`) : null;
  if (hunk) {
    const box = scrollParent(hunk);
    const r = hunk.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    scrollQuickly(box, box.scrollTop + r.top - b.top - box.clientHeight / 3);
  }
}

function step(by: number) {
  const n = hunks().length;
  if (!n) return;
  current = (current + by + n) % n;
  showCurrent(true);
}

/** The run of changes the caret is in, else the current one. */
function hunkAtCaret(): number {
  const list = hunks();
  if (!view) return current;
  const { from } = view.state.selection;
  const i = list.findIndex((h) => !h.front && from >= h.from && from <= h.to);
  return i >= 0 ? i : current;
}

function resolveChange(action: "keep" | "undo", index: number) {
  const h = hunks()[index];
  if (!h || !view || !host || busy()) return;
  host.flush();
  const { doc } = view.state;
  let reverted: string;
  if (h.front) reverted = host.fullText(doc, original!);
  else {
    const tr = view.state.tr;
    if (h.removed.length) tr.replaceWith(h.from, h.to, h.removed);
    else tr.delete(h.from, h.to);
    reverted = host.fullText(tr.doc);
  }
  busyUntil = Date.now() + 3000;
  current = index;
  host.post({ type: "agentAction", action, scope: "change", current: host.fullText(doc), reverted });
}

function resolveFile(action: "keep" | "undo") {
  if (!host || busy() || !agentEdits.pending()) return;
  host.flush();
  busyUntil = Date.now() + 3000;
  host.post({ type: "agentAction", action, scope: "file" });
}

/** Keyboard commands (webview/commands.ts). */
export const agentEdits = {
  pending: () => hunks().length > 0 || isAdded(),
  keepChange: () => (isAdded() ? resolveFile("keep") : resolveChange("keep", hunkAtCaret())),
  undoChange: () => (isAdded() ? resolveFile("undo") : resolveChange("undo", hunkAtCaret())),
  keepFile: () => resolveFile("keep"),
  undoFile: () => resolveFile("undo"),
  next: () => step(1),
  previous: () => step(-1),
};

/** The editor plugin; `install` connects it to the page. */
export const agentEditsPlugin = $prose(
  () =>
    new Plugin<State>({
      key,
      state: {
        init: () => ({ decos: DecorationSet.empty, hunks: [] }),
        apply(tr, prev) {
          const next = tr.getMeta(key) as State | undefined;
          if (next) return next;
          if (!tr.docChanged) return prev;
          if (prev.added) return { ...prev, decos: prev.decos.map(tr.mapping, tr.doc) };
          const hunks = prev.hunks.map((h) => ({ ...h, from: tr.mapping.map(h.from, -1), to: Math.max(tr.mapping.map(h.from, -1), tr.mapping.map(h.to, 1)) }));
          return { decos: prev.decos.map(tr.mapping, tr.doc), hunks };
        },
      },
      props: { decorations: (state) => key.getState(state)?.decos },
      view: () => ({
        update(v, prev) {
          if (!original || v.state.doc.eq(prev.doc)) return;
          clearTimeout(timer);
          timer = setTimeout(refresh, 150);
        },
      }),
    }),
);

export function installAgentEdits(editorView: EditorView, h: AgentEditsHost) {
  view = editorView;
  host = h;
  if (!bar.isConnected) document.body.append(bar);
}

/** The file as it was before the agent's pending edits, or null when there are none. */
export function setAgentOriginal(text: string | null) {
  if (!host) return;
  if (text === null) original = null;
  else {
    const { front, gap, markdown } = host.split(text);
    const doc = host.parse(markdown);
    original = doc ? { front, gap, doc } : null;
  }
  refresh();
}
