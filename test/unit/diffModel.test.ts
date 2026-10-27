// The diff view's model: blocks kept, removed and added, and what changed
// inside an edited block.
import { describe, expect, it } from "vitest";
import { editorViewCtx, parserCtx } from "@milkdown/kit/core";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";

import { diffBlocks, layoutDiff } from "../../webview/diffModel";
import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();

async function withParser(fn: (parse: (md: string) => ProseNode) => void) {
  const ed = await mountEditor("");
  try {
    ed.crepe.editor.action((ctx) => {
      ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);
      fn((md) => parser(md)!);
    });
  } finally {
    await ed.destroy();
  }
}

const summary = (entries: ReturnType<typeof diffBlocks>) =>
  entries.map((e) => `${e.kind === "same" ? "=" : e.kind === "added" ? "+" : "-"}${e.pair ? "~" : ""}${e.node.textContent}`);

describe("diff model", () => {
  it("keeps unchanged blocks and pairs edited ones", async () => {
    await withParser((parse) => {
      const entries = diffBlocks(parse("# Title\n\nold text\n\ngone\n\nend\n"), parse("# Title\n\nnew text\n\nend\n\nadded\n"));
      expect(summary(entries)).toEqual(["=Title", "-~old text", "+~new text", "-gone", "=end", "+added"]);
    });
  });

  it("lays out each side with block and word marks", async () => {
    await withParser((parse) => {
      const entries = diffBlocks(parse("a\n\nthe old word\n"), parse("a\n\nthe new word\n\nb\n"));
      const combined = layoutDiff(entries, "combined");
      expect(combined.nodes.map((n) => n.textContent)).toEqual(["a", "the old word", "the new word", "b"]);
      expect([combined.edited, combined.added, combined.removed]).toEqual([1, 1, 0]);
      const blocks = combined.marks.filter((m) => m.block).map((m) => [m.className, m.anchor]);
      expect(blocks).toEqual([
        ["", "s0"],
        ["ken-diff-removed ken-diff-edited", "c1"],
        ["ken-diff-added ken-diff-edited", "c1"],
        ["ken-diff-added", "c1"],
      ]);
      const doc = parse("a\n\nthe new word\n\nb\n");
      const right = layoutDiff(entries, "new");
      expect(right.nodes.map((n) => n.textContent)).toEqual(["a", "the new word", "b"]);
      const words = right.marks.filter((m) => !m.block);
      expect(words).toHaveLength(1);
      expect(doc.textBetween(words[0]!.from, words[0]!.to)).toBe("new");
      const left = layoutDiff(entries, "old");
      expect(left.nodes.map((n) => n.textContent)).toEqual(["a", "the old word"]);
    });
  });

  it("reports no changes for identical documents", async () => {
    await withParser((parse) => {
      const result = layoutDiff(diffBlocks(parse("x\n\n- y\n"), parse("x\n\n- y\n")), "combined");
      expect(result.added + result.removed + result.edited).toBe(0);
    });
  });
});
