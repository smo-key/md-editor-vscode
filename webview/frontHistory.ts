// Frontmatter edits in the editor's undo history.
//
// The frontmatter (the Properties panel) is set aside from the ProseMirror
// document (main.ts), so its edits would bypass ProseMirror's history and
// Cmd+Z would skip them, undoing older body typing instead. Each frontmatter
// change is therefore recorded as a `FrontStep`: a step that leaves the
// document as it is and carries the frontmatter (and the blank lines after
// it) before and after. prosemirror-history stores, groups and inverts it
// like any other step, so undo and redo walk body and frontmatter edits in
// the order they were made. This plugin keeps the frontmatter the history
// says; when an undo or redo changes it, `onRestore` hands it to main.ts.
//
// A change from outside (`resetFront`) makes older frontmatter steps stale:
// undoing them would overwrite it, so they are skipped, and an undo or redo
// that would only have skipped them goes on to the next event.
//
// In a collaboration session the shared history (y-prosemirror's undo
// manager) is used instead and tracks the shared frontmatter itself
// (collab.ts); the steps recorded here are then simply not undone.
import { Plugin, PluginKey, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import { Step, StepMap, StepResult, type Mappable } from "@milkdown/kit/prose/transform";
import type { Node, Schema } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { redo, undo } from "@milkdown/kit/prose/history";

/** The frontmatter block and the blank lines that follow it, kept exactly. */
export interface FrontState {
  front: string;
  gap: string;
}

const same = (a: FrontState, b: FrontState) => a.front === b.front && a.gap === b.gap;

/** A frontmatter change: a no-op on the document that history can invert. */
export class FrontStep extends Step {
  constructor(
    readonly from: FrontState,
    readonly to: FrontState,
  ) {
    super();
  }

  apply(doc: Node): StepResult {
    return StepResult.ok(doc);
  }

  getMap(): StepMap {
    return StepMap.empty;
  }

  invert(): Step {
    return new FrontStep(this.to, this.from);
  }

  map(_mapping: Mappable): Step {
    return this;
  }

  merge(): Step | null {
    return null;
  }

  toJSON() {
    return { stepType: "ken-front", from: this.from, to: this.to };
  }

  static fromJSON(_schema: Schema, json: { from: FrontState; to: FrontState }): FrontStep {
    return new FrontStep(json.from, json.to);
  }
}
Step.jsonID("ken-front", FrontStep);

/**
 * The history's frontmatter; `restored` when an undo or redo (not an edit
 * here) set it; `skip` when an undo or redo only had stale steps to take.
 */
interface HistoryFront extends FrontState {
  restored: boolean;
  skip: "undo" | "redo" | null;
}

const key = new PluginKey<HistoryFront>("ken-front-history");
/** prosemirror-history's plugin key name: its undo and redo transactions carry this meta. */
const HISTORY = "history$";

/** Frontmatter edits closer together than this undo as one. */
export const FRONT_GROUP_MS = 500;

/**
 * The plugin. `onRestore` gets the frontmatter an undo or redo went back
 * (or forward) to.
 */
export function frontHistory(onRestore: (state: FrontState) => void): Plugin<HistoryFront> {
  return new Plugin<HistoryFront>({
    key,
    state: {
      init: () => ({ front: "", gap: "", restored: false, skip: null }),
      apply(tr, value) {
        const meta = tr.getMeta(key) as { reset?: FrontState; own?: boolean } | undefined;
        if (meta?.reset) return { ...meta.reset, restored: false, skip: null };
        let next: FrontState = value;
        for (const step of tr.steps) {
          // A step written against other frontmatter (it changed outside the
          // editor since) is stale: undoing it would throw that change away.
          if (step instanceof FrontStep && same(step.from, next)) next = step.to;
        }
        if (next !== value) return { front: next.front, gap: next.gap, restored: !meta?.own, skip: null };
        // An undo or redo (prosemirror-history's own transactions) that only
        // had stale frontmatter steps changed nothing you can see.
        const popped = tr.getMeta(HISTORY) as { redo: boolean } | undefined;
        const skip =
          popped && tr.steps.length > 0 && tr.steps.every((step) => step instanceof FrontStep)
            ? popped.redo
              ? "redo"
              : "undo"
            : null;
        return skip || value.skip ? { ...value, restored: false, skip } : value;
      },
    },
    view: () => ({
      update(view, prev) {
        const now = key.getState(view.state)!;
        if (now === key.getState(prev)) return;
        if (now.restored) onRestore({ front: now.front, gap: now.gap });
        // Go on to the next event, so one press always does something. The
        // shared history of a collaboration session (y-prosemirror) never
        // sets the meta, so it is left alone.
        if (now.skip === "undo") undo(view.state, view.dispatch);
        else if (now.skip === "redo") redo(view.state, view.dispatch);
      },
    }),
  });
}

/** The frontmatter the editor's history currently stands at. */
export function historyFront(state: EditorState): FrontState | undefined {
  const value = key.getState(state);
  return value && { front: value.front, gap: value.gap };
}

// Consecutive frontmatter edits (typing in a property) group into one undo,
// until a pause or a body edit comes between them.
let burst = 0;
let lastEdit = { time: 0, doc: null as Node | null, burst: 0 };

/** Record a frontmatter edit made here (the panel, the numbering dialog). */
export function recordFront(view: EditorView, to: FrontState, now = Date.now()): void {
  const from = key.getState(view.state);
  if (!from || same(from, to)) return;
  const doc = view.state.doc;
  const continues = lastEdit.doc === doc && now - lastEdit.time < FRONT_GROUP_MS;
  if (!continues) burst++;
  lastEdit = { time: now, doc, burst };
  const tr: Transaction = view.state.tr.step(new FrontStep({ front: from.front, gap: from.gap }, to)).setMeta(key, { own: true });
  // Equal `composition` values join one history event; a new one starts another.
  tr.setMeta("composition", `ken-front-${burst}`);
  view.dispatch(tr);
  // A body edit since replaces the document: the next frontmatter edit starts a new event.
  lastEdit.doc = view.state.doc;
}

/** The frontmatter changed outside the history (opened, the file, a collaborator): the new baseline. */
export function resetFront(view: EditorView, to: FrontState): void {
  const from = key.getState(view.state);
  if (!from || same(from, to)) return;
  view.dispatch(view.state.tr.setMeta(key, { reset: to }).setMeta("addToHistory", false));
}
