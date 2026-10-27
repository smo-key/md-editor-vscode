// Paste as plain text (Cmd/Ctrl+Shift+V): the text takes the formatting of
// where it lands.
import { describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

import { command, execute, insertPlainText, setClipboardReader } from "../../webview/commands";
import { normalizeTrailingNewlines } from "../../webview/markdown/gfmFidelity";
import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();

function caretAfter(view: EditorView, text: string) {
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return found < 0;
    const i = node.text!.indexOf(text);
    if (i >= 0) found = pos + i + text.length;
    return false;
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, found)));
}

async function withEditor(markdown: string, fn: (view: EditorView, md: () => string, run: (id: string) => void) => void | Promise<void>) {
  const ed = await mountEditor(markdown);
  const view = ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
  try {
    await fn(view, () => normalizeTrailingNewlines(ed.markdown()), (id) => ed.crepe.editor.action((ctx) => execute(ctx, command(id))));
  } finally {
    await ed.destroy();
  }
}

describe("paste as plain text", () => {
  it("takes the caret's formatting, not the clipboard's Markdown", async () => {
    await withEditor("Say **bold** now\n", (view, md) => {
      caretAfter(view, "bol");
      insertPlainText(view, "*x* [y](z)");
      expect(md()).toBe("Say **bol\\*x\\* \\[y]\\(z)d** now\n");
    });
  });

  it("each further line is a new block like the caret's", async () => {
    await withEditor("- [ ] one\n\nPara\n", (view, md) => {
      caretAfter(view, "one");
      insertPlainText(view, " a\r\nb");
      caretAfter(view, "Para");
      insertPlainText(view, "\nnext");
      expect(md()).toBe("- [ ] one a\n- [ ] b\n\nPara\n\nnext\n");
    });
  });

  it("is code in code", async () => {
    await withEditor("```js\nx\n```\n", (view, md) => {
      caretAfter(view, "x");
      insertPlainText(view, "\n**y**");
      expect(md()).toBe("```js\nx\n**y**\n```\n");
    });
  });

  it("runs from the command, reading the clipboard through the host", async () => {
    setClipboardReader(async () => "plain");
    await withEditor("Hi\n", async (view, md, run) => {
      caretAfter(view, "Hi");
      run("paste-plain");
      await new Promise((r) => setTimeout(r, 0));
      expect(md()).toBe("Hiplain\n");
    });
  });
});
