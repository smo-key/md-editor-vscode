// Move up/down and duplicate (Alt+↑/↓, Shift+Alt+↓): the caret's table row,
// list item or block; clear formatting; check/uncheck a checklist item.
import { describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

import { command, execute } from "../../webview/commands";
import { normalizeTrailingNewlines } from "../../webview/markdown/gfmFidelity";
import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();

function select(view: EditorView, text: string, length = 0) {
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return found < 0;
    const i = node.text!.indexOf(text);
    if (i >= 0) found = pos + i;
    return false;
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, found, found + length)));
}

async function withEditor(markdown: string, fn: (view: EditorView, md: () => string, run: (id: string) => boolean) => void) {
  const ed = await mountEditor(markdown);
  const view = ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
  const run = (id: string) => {
    const cmd = command(id);
    const enabled = cmd.isEnabled ? cmd.isEnabled(view.state) : true;
    ed.crepe.editor.action((ctx) => execute(ctx, cmd));
    return enabled;
  };
  try {
    fn(view, () => normalizeTrailingNewlines(ed.markdown()), run);
  } finally {
    await ed.destroy();
  }
}

describe("move up / down", () => {
  it("moves a paragraph, keeping the caret in it", async () => {
    await withEditor("one\n\ntwo\n\nthree\n", (view, md, run) => {
      select(view, "three");
      run("move-up");
      expect(md()).toBe("one\n\nthree\n\ntwo\n");
      expect(view.state.selection.$from.parent.textContent).toBe("three");
      run("move-up");
      expect(run("move-up")).toBe(false);
      expect(md()).toBe("three\n\none\n\ntwo\n");
    });
  });

  it("moves a list item among its siblings", async () => {
    await withEditor("- a\n- b\n  - b1\n- c\n", (view, md, run) => {
      select(view, "b1");
      expect(run("move-down")).toBe(false);
      select(view, "a");
      run("move-down");
      expect(md()).toBe("- b\n  - b1\n- a\n- c\n");
    });
  });

  it("moves a table row, never above the header", async () => {
    await withEditor("| h |\n| - |\n| 1 |\n| 2 |\n", (view, md, run) => {
      select(view, "2");
      run("move-up");
      expect(md()).toBe("| h |\n| - |\n| 2 |\n| 1 |\n");
      expect(run("move-up")).toBe(false);
      select(view, "h");
      expect(run("move-down")).toBe(false);
    });
  });

  it("duplicates a row, item or block below itself", async () => {
    await withEditor("| h |\n| - |\n| 1 |\n\n- a\n\npara\n", (view, md, run) => {
      select(view, "1");
      run("duplicate");
      select(view, "a");
      run("duplicate");
      select(view, "para");
      run("duplicate");
      expect(md()).toBe("| h |\n| - |\n| 1 |\n| 1 |\n\n- a\n- a\n\npara\n\npara\n");
    });
  });
});

describe("clear formatting and checklist items", () => {
  it("clears bold and italic but keeps links", async () => {
    await withEditor("**bold *it* [l](u)** end\n", (view, md, run) => {
      select(view, "bold", "bold it l".length);
      run("clear-format");
      expect(md()).toBe("bold it [l](u) end\n");
    });
  });

  it("checks and unchecks the caret's item", async () => {
    await withEditor("- [ ] todo\n- plain\n", (view, md, run) => {
      select(view, "todo");
      run("toggle-task");
      expect(md()).toBe("- [x] todo\n- plain\n");
      select(view, "plain");
      expect(run("toggle-task")).toBe(false);
    });
  });
});
