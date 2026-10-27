// Lists left directly next to each other become one list; only other content
// between them keeps them apart.
import { describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import { undo } from "@milkdown/kit/prose/history";
import type { EditorView } from "@milkdown/kit/prose/view";

import { command, execute } from "../../webview/commands";
import { normalizeTrailingNewlines } from "../../webview/markdown/gfmFidelity";
import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();

function caretIn(view: EditorView, text: string) {
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return found < 0;
    const i = node.text!.indexOf(text);
    if (i >= 0) found = pos + i;
    return false;
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, found)));
}

/** Delete the top-level block holding `text`. */
function deleteBlock(view: EditorView, text: string) {
  caretIn(view, text);
  const $p = view.state.selection.$from;
  view.dispatch(view.state.tr.delete($p.before(1), $p.after(1)));
}

async function withEditor(markdown: string, fn: (view: EditorView, md: () => string, run: (id: string) => void) => void) {
  const ed = await mountEditor(markdown);
  const view = ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
  try {
    fn(view, () => normalizeTrailingNewlines(ed.markdown()), (id) => ed.crepe.editor.action((ctx) => execute(ctx, command(id))));
  } finally {
    await ed.destroy();
  }
}

const lists = (view: EditorView) => {
  const out: string[] = [];
  view.state.doc.forEach((n) => {
    if (n.type.name.endsWith("_list")) out.push(`${n.type.name}:${n.childCount}`);
  });
  return out;
};

describe("touching lists join", () => {
  it("when the paragraph between them is deleted, in one undo step", async () => {
    await withEditor("- a\n- b\n\nmiddle\n\n- c\n", (view, md) => {
      deleteBlock(view, "middle");
      expect(lists(view)).toEqual(["bullet_list:3"]);
      expect(md()).toBe("- a\n- b\n- c\n");
      undo(view.state, view.dispatch);
      expect(md()).toBe("- a\n- b\n\nmiddle\n\n- c\n");
    });
  });

  it("when a list is made between two lists", async () => {
    await withEditor("1. a\n\nmiddle\n\n2. c\n", (view, md, run) => {
      caretIn(view, "middle");
      run("ordered-list");
      expect(lists(view)).toEqual(["ordered_list:3"]);
      expect(md()).toBe("1. a\n2. middle\n3. c\n");
    });
  });

  it("a checklist joins a bulleted list next to it", async () => {
    await withEditor("- a\n\nmiddle\n", (view, md, run) => {
      caretIn(view, "middle");
      run("task-list");
      expect(lists(view)).toEqual(["bullet_list:2"]);
      expect(md()).toBe("- a\n- [ ] middle\n");
    });
  });

  it("joins nested lists too", async () => {
    await withEditor("- a\n  - x\n\n  middle\n\n  - y\n", (view) => {
      caretIn(view, "middle");
      const $p = view.state.selection.$from;
      view.dispatch(view.state.tr.delete($p.before(), $p.after()));
      const item = view.state.doc.firstChild!.firstChild!;
      expect(item.childCount).toBe(2);
      expect(item.child(1).childCount).toBe(2);
    });
  });

  it("keeps numbered and bulleted lists apart, and other content between lists", async () => {
    await withEditor("1. a\n\nmiddle\n\n- c\n\ntext\n\n- d\n", (view, _md, run) => {
      caretIn(view, "middle");
      run("bullet-list");
      expect(lists(view)).toEqual(["ordered_list:1", "bullet_list:2", "bullet_list:1"]);
    });
  });

  it("leaves a file's own touching lists alone when it is opened", async () => {
    await withEditor("- a\n\n* b\n", (view) => {
      expect(lists(view)).toEqual(["bullet_list:1", "bullet_list:1"]);
    });
  });
});
