// The diff view's model: blocks kept, removed and added, and what changed
// inside an edited block.
import { describe, expect, it } from "vitest";
import { editorViewCtx, parserCtx } from "@milkdown/kit/core";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";

import { Transform } from "@milkdown/kit/prose/transform";
import { combinedWidgets, diffBlocks, layoutDiff, syncedScrollTop } from "../../webview/diffModel";
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

  it("ignores how a link was written (the table of contents the editor rebuilds)", async () => {
    await withParser((parse) => {
      const old = parse("- [One](#one)\n- [Two](#two)\n");
      // Rebuilt by the editor: the same links, without the syntax they were read in.
      const tr = new Transform(old);
      old.descendants((n, pos) => {
        const link = n.marks.find((m) => m.type.name === "link");
        if (n.isText && link) tr.addMark(pos, pos + n.nodeSize, link.type.create({ ...link.attrs, form: null }));
        return true;
      });
      const newDoc = tr.doc;
      expect(old.firstChild!.firstChild!.firstChild!.firstChild!.marks[0]!.attrs.form).not.toBeNull();
      expect(summary(diffBlocks(old, newDoc))).toEqual(["=OneTwo"]);
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

  it("places removed blocks before the block that follows them in the new document", async () => {
    await withParser((parse) => {
      const oldDoc = parse("a\n\ngone\n\nthe old word\n\nz\n");
      const newDoc = parse("a\n\nthe new word\n\nz\n");
      const widgets = combinedWidgets(diffBlocks(oldDoc, newDoc));
      expect(widgets.map((w) => [w.entry.node.textContent, newDoc.resolve(w.pos).index()])).toEqual([
        ["gone", 1],
        ["the old word", 1],
      ]);
      // The edited block's removed word, as text offsets.
      const edited = widgets[1]!;
      expect(edited.words.map(([a, b]) => "the old word".slice(a, b))).toEqual(["old"]);
    });
  });

  it("treats blocks that differ only in attributes the editor derives as unchanged", async () => {
    await withParser((parse) => {
      const doc = parse("# Title\n");
      const relabelled = doc.type.create(null, doc.firstChild!.type.create({ ...doc.firstChild!.attrs, id: "other" }, doc.firstChild!.content));
      expect(diffBlocks(doc, relabelled).map((e) => e.kind)).toEqual(["same"]);
    });
  });
});


describe("table diff", () => {
  const table = (rows: string[][]) => rows.map((r, i) => `| ${r.join(" | ")} |` + (i === 0 ? `\n|${r.map(() => " --- ").join("|")}|` : "")).join("\n") + "\n";
  const base = [
    ["Name", "Role", "City"],
    ["Ada", "Engineer", "London"],
    ["Bob", "Designer", "Paris"],
    ["Cy", "Manager", "Rome"],
  ];
  const ops = (o: { old: number | null; new: number | null }[]) => o.map((x) => (x.old == null ? "+" : x.new == null ? "-" : "="));
  /** The text of each changed row/cell mark, and of each changed run, on one side. */
  const changed = (doc: ProseNode, marks: { from: number; to: number; block: boolean; className: string }[]) =>
    marks.filter((m) => /-part|-text/.test(m.className)).map((m) => `${m.className.split(" ")[0]}${m.className.includes("cell-edited") ? "~" : ""}${m.className.includes("row") ? "#" : ""}:${doc.textBetween(m.from, m.to, " ", " ")}`);

  function check(oldRows: string[][], newRows: string[][], fn: (r: { entries: ReturnType<typeof diffBlocks>; oldDoc: ProseNode; newDoc: ProseNode }) => void) {
    return withParser((parse) => {
      const oldDoc = parse(table(oldRows));
      const newDoc = parse(table(newRows));
      fn({ entries: diffBlocks(oldDoc, newDoc), oldDoc, newDoc });
    });
  }

  it("marks only the cells that changed", async () => {
    const next = base.map((r) => [...r]);
    next[2]![2] = "Berlin";
    await check(base, next, ({ entries, oldDoc, newDoc }) => {
      const t = entries[0]!.table!;
      expect(ops(t.rows)).toEqual(["=", "=", "=", "="]);
      expect(ops(t.cols)).toEqual(["=", "=", "="]);
      expect(changed(newDoc, layoutDiff(entries, "new").marks)).toEqual(["ken-diff-added-part~:Berlin", "ken-diff-added-text:Berlin"]);
      expect(changed(oldDoc, layoutDiff(entries, "old").marks)).toEqual(["ken-diff-removed-part~:Paris", "ken-diff-removed-text:Paris"]);
      const w = combinedWidgets(entries);
      expect(w.map((x) => [x.part?.kind, x.part?.kind === "cell-old" ? x.part.cell.textContent : ""])).toEqual([["cell-old", "Paris"]]);
      expect(w[0]!.words).toEqual([[0, 5]]);
      // Inside the new cell, before its text.
      expect(newDoc.resolve(w[0]!.pos).parent.type.name).toBe("table_cell");
      expect(newDoc.textBetween(w[0]!.pos, w[0]!.pos + 7)).toBe("Berlin");
    });
  });

  it("marks a removed and an added row", async () => {
    const next = [base[0]!, base[1]!, base[3]!, ["Dee", "Analyst", "Oslo"]];
    await check(base, next, ({ entries, oldDoc, newDoc }) => {
      expect(ops(entries[0]!.table!.rows)).toEqual(["=", "=", "-", "=", "+"]);
      expect(changed(oldDoc, layoutDiff(entries, "old").marks)).toEqual(["ken-diff-removed-part#:Bob Designer Paris"]);
      expect(changed(newDoc, layoutDiff(entries, "new").marks)).toEqual(["ken-diff-added-part#:Dee Analyst Oslo"]);
      const w = combinedWidgets(entries);
      expect(w).toHaveLength(1);
      expect(w[0]!.part).toMatchObject({ kind: "row" });
      expect((w[0]!.part as { cells: ProseNode[] }).cells.map((c) => c.textContent)).toEqual(["Bob", "Designer", "Paris"]);
      // Before the row it was above (Cy's).
      const $pos = newDoc.resolve(w[0]!.pos);
      expect($pos.parent.type.name).toBe("table");
      expect($pos.nodeAfter!.textContent).toBe("CyManagerRome");
    });
  });

  it("marks a removed and an added column", async () => {
    const next = base.map(([name, , city], i) => [name!, city!, i === 0 ? "Team" : `T${i}`]);
    await check(base, next, ({ entries, oldDoc, newDoc }) => {
      const t = entries[0]!.table!;
      expect(ops(t.cols)).toEqual(["=", "-", "=", "+"]);
      expect(ops(t.rows)).toEqual(["=", "=", "=", "="]);
      expect(changed(oldDoc, layoutDiff(entries, "old").marks)).toEqual(["Role", "Engineer", "Designer", "Manager"].map((x) => `ken-diff-removed-part:${x}`));
      expect(changed(newDoc, layoutDiff(entries, "new").marks)).toEqual(["Team", "T1", "T2", "T3"].map((x) => `ken-diff-added-part:${x}`));
      const w = combinedWidgets(entries);
      expect(w.map((x) => (x.part?.kind === "cell" ? [x.part.cell?.textContent, x.part.header, newDoc.resolve(x.pos).nodeAfter?.textContent] : null))).toEqual([
        ["Role", true, "City"],
        ["Engineer", false, "London"],
        ["Designer", false, "Paris"],
        ["Manager", false, "Rome"],
      ]);
    });
  });

  it("leaves gaps in a removed row for an added column", async () => {
    const next = [
      [...base[0]!, "Team"],
      [...base[1]!, "A"],
      [...base[3]!, "C"],
    ];
    await check(base, next, ({ entries }) => {
      const row = combinedWidgets(entries).find((w) => w.part?.kind === "row")!;
      expect((row.part as { cells: (ProseNode | null)[] }).cells.map((c) => c?.textContent ?? null)).toEqual(["Bob", "Designer", "Paris", null]);
    });
  });

  it("keeps a row whose label is the same while its values change", async () => {
    const next = base.map((r) => [...r]);
    next[1] = ["Ada", "Director", "Madrid"];
    await check(base, next, ({ entries }) => {
      expect(ops(entries[0]!.table!.rows)).toEqual(["=", "=", "=", "="]);
    });
  });
});


describe("split view scrolling", () => {
  const left = [
    { anchor: "s0", top: 0, bottom: 100 },
    { anchor: "c1", top: 100, bottom: 300 },
    { anchor: "s2", top: 300, bottom: 400 },
  ];
  const right = [
    { anchor: "s0", top: 0, bottom: 100 },
    { anchor: "s2", top: 100, bottom: 200 },
  ];
  it("keeps the same point of the same block at the top", () => {
    expect(syncedScrollTop(50, left, right)).toBe(50);
    expect(syncedScrollTop(350, left, right)).toBe(150);
  });
  it("holds the other side at the gap while a run only one side has scrolls past", () => {
    expect(syncedScrollTop(150, left, right)).toBe(100);
    expect(syncedScrollTop(250, left, right)).toBe(100);
  });
});
