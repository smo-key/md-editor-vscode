/**
 * A key acts at the caret the user sees.
 *
 * ProseMirror learns about a click's new caret from the browser's
 * `selectionchange` event, which arrives as a task of its own after the
 * mouseup. A key pressed right after the click can be handled first (input
 * events jump that queue when the page is busy, and automated input always
 * can), and every key handler then ran against the old caret: a Backspace
 * next to a comment marker skipped the marker logic and the browser deleted
 * the marker instead, which the comment plugin restored, so the keystroke
 * was lost. ProseMirror itself only flushes pending DOM mutations on
 * keydown, not a pending selection; this reads the selection too, through
 * ProseMirror's own DOM observer (the same code `selectionchange` runs), and
 * does nothing when the two already agree.
 */
import { editorViewOptionsCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import type { EditorView } from "@milkdown/kit/prose/view";

interface DomObserver {
  flush(): void;
}

/** Bring ProseMirror's selection up to date with the DOM's, if it lags. */
export function syncSelectionFromDOM(view: EditorView): void {
  if (view.composing) return;
  const observer = (view as unknown as { domObserver?: DomObserver }).domObserver;
  observer?.flush();
}

/** Wraps the view's keydown handler: runs before every other key handler. */
export function keySelectionSync(ctx: Ctx): void {
  ctx.update(editorViewOptionsCtx, (opts) => {
    const prev = opts.handleKeyDown;
    return {
      ...opts,
      handleKeyDown: (view, event) => {
        if (!event.isComposing && event.keyCode !== 229) syncSelectionFromDOM(view);
        return prev?.(view, event) ?? false;
      },
    };
  });
}
