/**
 * Real-time collaboration in the editor: the ProseMirror document is bound to
 * a shared Y.js document (y-prosemirror), so everyone's edits merge as they
 * type, and presence (who is here, their carets and selections) travels as
 * Y.js awareness. The host relays both to the session's hub (src/collab).
 *
 * The frontmatter and comment threads live outside the ProseMirror document
 * (see main.ts), so they are shared beside it: the frontmatter as one string,
 * the threads one entry per thread.
 */
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import {
  absolutePositionToRelativePosition,
  updateYFragment,
  redoCommand,
  undoCommand,
  yCursorPlugin,
  ySyncPlugin,
  ySyncPluginKey,
  yUndoPlugin,
  yUndoPluginKey,
} from "y-prosemirror";
import { Plugin, PluginKey, type EditorState } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

/** Origin of changes that came from other people (not echoed back). */
const REMOTE = "remote";

/** Each person's colour: VS Code's chart colours, so it follows the theme. */
const HUES: Record<string, string> = {
  blue: "#3794ff",
  green: "#89d185",
  purple: "#b180d7",
  orange: "#d18616",
  red: "#f14c4c",
  yellow: "#cca700",
};

export interface Person {
  id: number;
  name: string;
  hue: string;
}

export interface CollabHooks {
  /** A local change to the shared document, for everyone else. */
  send(update: Uint8Array): void;
  sendAwareness(update: Uint8Array): void;
  /** Someone else changed the frontmatter. */
  onFront(front: string): void;
  /** Someone else changed the comment threads: one JSON thread per entry. */
  onThreads(threads: string[]): void;
  /** Who else is here changed. */
  onPeople(people: Person[]): void;
}

export const hueVar = (hue: string) => `var(--vscode-charts-${hue in HUES ? hue : "blue"})`;

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

/** Undo/redo in a shared document only take back your own changes. */
export function sharedHistory(state: EditorState): { undo: typeof undoCommand; redo: typeof redoCommand } | null {
  return yUndoPluginKey.getState(state) ? { undo: undoCommand, redo: redoCommand } : null;
}

function caretElement(user: { name?: string; hue?: string }): HTMLElement {
  const caret = document.createElement("span");
  caret.className = "ken-collab-caret";
  caret.style.setProperty("--who", hueVar(user.hue ?? "blue"));
  const label = document.createElement("span");
  label.className = "ken-collab-name";
  label.textContent = user.name ?? "Someone";
  caret.append("\u2060", label, "\u2060");
  return caret;
}

export class Collab {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  private readonly fragment = this.doc.getXmlFragment("prosemirror");
  private readonly meta = this.doc.getMap<string>("meta");
  private readonly threads = this.doc.getMap<string>("threads");
  private plugins: Plugin[] = [];
  private stopped = false;

  constructor(
    private readonly view: EditorView,
    private readonly hooks: CollabHooks,
    name: string,
  ) {
    const hues = Object.keys(HUES);
    const hue = hues[this.doc.clientID % hues.length]!;
    this.awareness.setLocalStateField("user", { name, hue, color: HUES[hue] });
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE && !this.stopped) hooks.send(update);
    });
    this.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        const changed = [...added, ...updated, ...removed];
        if (origin !== REMOTE && changed.length) hooks.sendAwareness(encodeAwarenessUpdate(this.awareness, changed));
      },
    );
    this.awareness.on("change", () => hooks.onPeople(this.people()));
    this.meta.observe((e) => {
      if (e.transaction.origin === REMOTE && e.keysChanged.has("front")) hooks.onFront(this.meta.get("front") ?? "");
    });
    this.threads.observe((e) => {
      if (e.transaction.origin === REMOTE) hooks.onThreads([...this.threads.values()]);
    });
  }

  /**
   * Join with the shared document: `seed` fills it from this editor (the
   * room was empty); otherwise the editor takes the shared one over.
   */
  start(seed: boolean, state: Uint8Array, awareness: Uint8Array, front: string, threads: string[]) {
    // Filling the room: the shared document is built from this editor's, and
    // y-prosemirror is told which node is which (`mapping`) so it does not
    // redraw the whole editor from it.
    let mapping: Map<unknown, unknown> | undefined;
    if (seed) {
      mapping = new Map();
      this.doc.transact(() => {
        updateYFragment(this.doc, this.fragment, this.view.state.doc, { mapping: mapping as never, isOMark: new Map() });
        this.meta.set("front", front);
        for (const t of threads) this.threads.set(threadId(t), t);
      });
    } else {
      Y.applyUpdate(this.doc, state, REMOTE);
    }
    if (awareness.length) applyAwarenessUpdate(this.awareness, awareness, REMOTE);
    this.plugins = [
      ySyncPlugin(this.fragment, mapping ? { mapping: mapping as never } : {}),
      yCursorPlugin(
        this.awareness,
        {
          cursorBuilder: caretElement,
          selectionBuilder: (user: { hue?: string }) => ({
            class: "ken-collab-selection",
            style: `--who: ${hueVar(user.hue ?? "blue")}`,
          }),
        },
        // y-prosemirror only shares the caret while the editor has focus;
        // caretPlugin shares it always (a glance at another window keeps
        // your place visible to others) in the field it draws from.
        "focusedCursor",
      ),
      yUndoPlugin(),
      this.caretPlugin(),
    ];
    this.view.updateState(this.view.state.reconfigure({ plugins: [...this.view.state.plugins, ...this.plugins] }));
    if (!seed) {
      this.hooks.onFront(this.meta.get("front") ?? "");
      this.hooks.onThreads([...this.threads.values()]);
    }
    this.hooks.onPeople(this.people());
  }

  apply(update: Uint8Array) {
    if (!this.stopped) Y.applyUpdate(this.doc, update, REMOTE);
  }

  applyAwareness(update: Uint8Array) {
    if (!this.stopped) applyAwarenessUpdate(this.awareness, update, REMOTE);
  }

  /** The frontmatter changed here. */
  setFront(front: string) {
    if (this.meta.get("front") !== front) this.meta.set("front", front);
  }

  /** The comment threads changed here: one JSON string per thread. */
  setThreads(threads: string[]) {
    const next = new Map(threads.map((t) => [threadId(t), t]));
    this.doc.transact(() => {
      for (const id of [...this.threads.keys()]) if (!next.has(id)) this.threads.delete(id);
      for (const [id, t] of next) if (this.threads.get(id) !== t) this.threads.set(id, t);
    });
  }

  people(): Person[] {
    const out: Person[] = [];
    this.awareness.getStates().forEach((s, id) => {
      if (id === this.doc.clientID || !s.user) return;
      out.push({ id, name: String(s.user.name ?? "Someone"), hue: String(s.user.hue ?? "blue") });
    });
    return out.sort((a, b) => a.id - b.id);
  }

  /** Leave: the editor keeps the text as it is and goes back to working alone. */
  stop() {
    if (this.stopped) return;
    removeAwarenessStates(this.awareness, [this.doc.clientID], "local");
    this.stopped = true;
    const mine = new Set(this.plugins);
    if (!this.view.isDestroyed) {
      this.view.updateState(this.view.state.reconfigure({ plugins: this.view.state.plugins.filter((p) => !mine.has(p)) }));
    }
    this.plugins = [];
    this.awareness.destroy();
    this.doc.destroy();
  }

  /** Shares this editor's caret and selection whenever they move. */
  private caretPlugin(): Plugin {
    let last = "";
    const publish = (view: EditorView) => {
      const ystate = ySyncPluginKey.getState(view.state);
      if (!ystate?.binding || this.stopped) return;
      try {
        const { anchor, head } = view.state.selection;
        const cursor = {
          anchor: absolutePositionToRelativePosition(anchor, ystate.type, ystate.binding.mapping),
          head: absolutePositionToRelativePosition(head, ystate.type, ystate.binding.mapping),
        };
        const json = JSON.stringify(cursor);
        if (json === last) return;
        last = json;
        this.awareness.setLocalStateField("cursor", cursor);
      } catch {
        // Positions not mapped yet: next time.
      }
    };
    return new Plugin({
      key: new PluginKey("ken-collab-caret"),
      view: (view) => {
        queueMicrotask(() => !view.isDestroyed && publish(view));
        return { update: (v) => publish(v) };
      },
    });
  }
}

function threadId(json: string): string {
  try {
    return String((JSON.parse(json) as { id?: unknown }).id ?? json);
  } catch {
    return json;
  }
}
