/**
 * Somewhere to type after the last block.
 *
 * A document that ends with a table, a diagram, a code block, an image, a
 * rule, a quote or a list must still let the caret go after it. Crepe's
 * trailing-paragraph plugin keeps an empty paragraph at the end, but only
 * after the first edit; this runs it on open as well (an empty last paragraph
 * is not written to the file, so opening stays a no-op), and makes a click in
 * the empty space below the document put the caret there.
 *
 * Between two blocks (a table straight after a code block, say) ProseMirror's
 * gap cursor takes over: arrow keys or a click between them stop there, and
 * typing starts a paragraph.
 */
import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

/** Whether the document ends in text a caret can go into (not code). */
function endsInParagraph(view: EditorView): boolean {
  const last = view.state.doc.lastChild;
  return !!last && last.isTextblock && !last.type.spec.code;
}

/** Put the caret at the very end, adding an empty paragraph first if needed. */
export function caretToEnd(view: EditorView): void {
  let tr = view.state.tr;
  if (!endsInParagraph(view)) tr = tr.insert(tr.doc.content.size, view.state.schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.atEnd(tr.doc));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

export const blockExitPlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey("ken-block-exit"),
      view: (view) => {
        // Let the trailing-paragraph plugin run once on open: it only reacts
        // to transactions. Not an edit, so kept out of the undo history.
        queueMicrotask(() => {
          if (!endsInParagraph(view)) view.dispatch(view.state.tr.setMeta("addToHistory", false));
        });

        // A click below the last block (in the pane's padding, outside the
        // editor element) goes to the end of the document.
        const pane = view.dom.closest<HTMLElement>(".editor-scroll") ?? view.dom.parentElement;
        const onDown = (e: MouseEvent) => {
          if (e.button !== 0 || view.dom.contains(e.target as Node)) return;
          if ((e.target as Element | null)?.closest?.("button, input, .ken-toolbar, .ken-col-resize")) return;
          const bottom = view.dom.getBoundingClientRect().bottom;
          const lastBlock = view.dom.lastElementChild?.getBoundingClientRect().bottom ?? bottom;
          if (e.clientY < Math.min(bottom, lastBlock)) return;
          e.preventDefault();
          caretToEnd(view);
        };
        pane?.addEventListener("mousedown", onDown);
        return { destroy: () => pane?.removeEventListener("mousedown", onDown) };
      },
    }),
);
