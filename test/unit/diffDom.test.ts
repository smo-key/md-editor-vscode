// Removed blocks in the combined diff view (webview/diffDom.ts): drawn by a
// read-only view of their own, exactly as the editor draws them.
import { describe, expect, it } from "vitest";
import { editorViewCtx, parserCtx } from "@milkdown/kit/core";
import type { EditorView } from "@milkdown/kit/prose/view";

import { combinedWidgets, diffBlocks } from "../../webview/diffModel";
import { destroyRemovedBlock, removedBlock, removedWidgets, withRemovedViews } from "../../webview/diffDom";
import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();

describe("removed blocks", () => {
  it("draw with the editor's own views, read-only, their removed words marked and their neighbour hidden", async () => {
    const ed = await mountEditor("Intro.\n\n- kept one\n- kept two\n");
    try {
      let view!: EditorView;
      let parse!: (md: string) => ReturnType<EditorView["state"]["doc"]["copy"]>;
      ed.crepe.editor.action((ctx) => {
        view = ctx.get(editorViewCtx);
        const parser = ctx.get(parserCtx);
        parse = (md) => parser(md)!;
      });
      const widgets = combinedWidgets(diffBlocks(parse("Intro.\n\n- gone one\n- gone two\n\nthe old word\n"), parse("Intro.\n\nthe new word\n")));
      expect(widgets.map((w) => w.entry.node.type.name)).toEqual(["bullet_list", "paragraph"]);

      const list = removedBlock(view, widgets[0]!);
      document.body.append(list);
      // Crepe's list item view, not plain HTML.
      expect(list.querySelectorAll(".milkdown-list-item-block")).toHaveLength(2);
      const inner = list.querySelector<HTMLElement>(".ken-diff-widget-view")!;
      expect(inner.getAttribute("contenteditable")).toBe("false");
      // The block before it (the intro) is there for spacing rules, hidden, and so is a caret holder after it.
      expect(list.querySelector("ul.ken-diff-removed")).not.toBeNull();
      const blocks = Array.from(inner.children).filter((c) => !c.classList.contains("ProseMirror-widget"));
      expect(blocks.map((c) => c.classList.contains("ken-diff-context"))).toEqual([true, false, true]);
      expect(withRemovedViews(view)).toHaveLength(1);

      const edited = removedBlock(view, widgets[1]!);
      document.body.append(edited);
      expect(edited.querySelector(".ken-diff-removed.ken-diff-edited")).not.toBeNull();
      expect(Array.from(edited.querySelectorAll(".ken-diff-removed-text"), (e) => e.textContent)).toEqual(["old"]);

      destroyRemovedBlock(list);
      destroyRemovedBlock(edited);
      list.remove();
      edited.remove();
    } finally {
      await ed.destroy();
    }
  });

  it("puts a hidden stand-in after the last removed block at a position, so the next block is spaced as if it were there", async () => {
    const ed = await mountEditor("a\n");
    try {
      ed.crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const parse = ctx.get(parserCtx);
        const widgets = combinedWidgets(diffBlocks(parse("x\n\n- y\n\na\n")!, parse("a\n")!));
        const decos = removedWidgets(view, widgets, "t", []);
        // Two removed blocks, then one stand-in (for the list, the last of them).
        expect(decos.map((d) => (d.spec as { key: string }).key.split("-")[1])).toEqual(["0", "1", "standin"]);
        expect((decos[2]!.spec as { key: string }).key).toContain("-ul");
      });
    } finally {
      await ed.destroy();
    }
  });
});
