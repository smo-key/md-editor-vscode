import { describe, expect, it } from "vitest";
import { columnWidths, tablesNeedingLayout } from "../../webview/markdown/tableLayout";
import type { TableMark } from "../../webview/markdown/tableLayout";

const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("columnWidths", () => {
  it("gives every column its content width when the table fits", () => {
    expect(columnWidths([96, 72, 122], 720, false)).toEqual([96, 72, 122]);
  });

  it("stretches a full-width table that would otherwise fit", () => {
    const w = columnWidths([77, 73, 83], 1104, true);
    expect(total(w)).toBeCloseTo(1104);
    // Proportional to content, so the order is kept.
    expect(w[2]).toBeGreaterThan(w[0]!);
    expect(w[0]).toBeGreaterThan(w[1]!);
  });

  it("keeps short columns whole and compresses the prose column", () => {
    // Date, Qty, Owner, Description — the shape the browser's own layout got
    // wrong: it squeezed the first three and starved the last.
    const w = columnWidths([110, 54, 73, 934], 720, false);
    expect(w.slice(0, 3)).toEqual([110, 54, 73]);
    expect(w[3]).toBeCloseTo(720 - 110 - 54 - 73);
  });

  it("shares the leftover between several wide columns, by content", () => {
    // Date, Owner, Status, Description, Notes. The three short columns only
    // become affordable together: protect any one of them on its own and a
    // squeezed column comes out narrower than it, so a search that has to
    // climb through those states one at a time protects none of them.
    const w = columnWidths([110, 76, 90, 934, 320], 720, false);
    expect(total(w)).toBeCloseTo(720);
    // The three short columns are rendered whole...
    expect(w.slice(0, 3)).toEqual([110, 76, 90]);
    // ...and the two wide ones absorb all of the compression, in order.
    expect(w[3]).toBeLessThan(934);
    expect(w[4]).toBeLessThan(320);
    expect(w[3]).toBeGreaterThan(w[4]!);
  });

  it("never exceeds the cap, however lopsided the content", () => {
    for (const cap of [1200, 1104, 720, 630, 400, 200]) {
      const w = columnWidths([1247, 108], cap, false);
      expect(total(w)).toBeLessThanOrEqual(cap + 0.01);
    }
  });

  it("orders the squeezed columns by content and keeps them usable", () => {
    // Fourteen columns in a 630px pane: nothing can be protected, so every
    // column takes a weighted share.
    const max = [
      110, 54, 75, 106, 135, 143, 106, 85, 144, 137, 116, 73, 1138, 337,
    ];
    const w = columnWidths(max, 630, false);
    expect(total(w)).toBeCloseTo(630);
    expect(Math.min(...w)).toBeGreaterThanOrEqual(27.9);
    // The description column stays the widest, and the ordering by content
    // survives the compression.
    expect(Math.max(...w)).toBe(w[12]);
    const order = max.map((_, i) => i).sort((a, b) => max[a]! - max[b]!);
    for (let i = 1; i < order.length; i++) {
      expect(w[order[i]!]).toBeGreaterThanOrEqual(w[order[i - 1]!]! - 0.01);
    }
  });

  it("compresses less than a linear split would", () => {
    const max = [110, 54, 73, 934];
    const w = columnWidths(max, 720, false);
    const linear = max.map((x) => (x * 720) / total(max));
    // A linear split gives the date column a third of what it needs.
    expect(w[0]).toBeGreaterThan(linear[0]! * 1.5);
  });

  it("handles degenerate input", () => {
    expect(columnWidths([], 720, false)).toEqual([]);
    expect(total(columnWidths([0, 0], 100, false))).toBeLessThanOrEqual(100);
  });
});

describe("tablesNeedingLayout", () => {
  // Stand-ins for ProseMirror nodes: only their identity matters.
  const a = { table: "a" };
  const b = { table: "b" };
  const mark = (node: unknown, width = 720): TableMark => ({ node, width });

  it("leaves a table alone when neither its node nor its container moved", () => {
    const current = [mark(a), mark(b)];
    expect(tablesNeedingLayout(current, [mark(a), mark(b)], false)).toEqual([]);
  });

  it("picks out only the table whose node was replaced", () => {
    // What an edit inside the second table looks like: ProseMirror rebuilds
    // that node and hands back the very same object for the first.
    const edited = { table: "b'" };
    const current = [mark(a), mark(edited)];
    expect(tablesNeedingLayout(current, [mark(a), mark(b)], false)).toEqual([
      1,
    ]);
  });

  it("re-measures a table whose container changed width", () => {
    const current = [mark(a, 640), mark(b)];
    expect(tablesNeedingLayout(current, [mark(a), mark(b)], false)).toEqual([
      0,
    ]);
  });

  it("re-measures a table that has never been laid out", () => {
    expect(
      tablesNeedingLayout([mark(a), mark(b)], [undefined, mark(b)], false),
    ).toEqual([0]);
  });

  it("takes every table when the pass is forced", () => {
    const current = [mark(a), mark(b)];
    expect(tablesNeedingLayout(current, current, true)).toEqual([0, 1]);
  });

  it("has nothing to do in a document without tables", () => {
    expect(tablesNeedingLayout([], [], true)).toEqual([]);
  });
});
