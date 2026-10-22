import { beforeAll, describe, expect, it } from "vitest";
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  remarkStringifyOptionsCtx,
  rootCtx,
} from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { callCommand, getMarkdown } from "@milkdown/kit/utils";
import { TextSelection } from "@milkdown/kit/prose/state";

import { collectHeadings } from "../../webview/markdown/anchors";
import {
  TOC_COMMENT,
  TOC_EMPTY_TEXT,
  TOC_H1_CLASS,
  TOC_SYNC_META,
  buildTocList,
  findTocList,
  insertTocCommand,
  isTocComment,
  tocEntries,
  tocPlugins,
} from "../../webview/markdown/toc";

// happy-dom does not implement the layout APIs ProseMirror's view layer calls
// while rendering; stub the few we need so the editor can mount headlessly.
beforeAll(() => {
  const proto = globalThis.Range.prototype as unknown as {
    getClientRects?: () => DOMRect[];
    getBoundingClientRect?: () => DOMRect;
  };
  const emptyRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  if (!proto.getClientRects) proto.getClientRects = () => [];
  if (!proto.getBoundingClientRect) proto.getBoundingClientRect = emptyRect;
  const el = globalThis.Element.prototype as unknown as {
    getClientRects?: () => DOMRect[];
  };
  if (!el.getClientRects) el.getClientRects = () => [];
});

async function makeEditor(markdown: string) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
      // House style, as MarkdownEditor.svelte configures it.
      ctx.update(remarkStringifyOptionsCtx, (opts) => ({
        ...opts,
        bullet: "-" as const,
      }));
    })
    .use(commonmark)
    .use(gfm)
    .use(tocPlugins)
    .create();
  // The sync plugin reconciles a stale on-disk TOC from a microtask.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return editor;
}

async function roundTrip(markdown: string): Promise<string> {
  const editor = await makeEditor(markdown);
  const out = editor.action(getMarkdown());
  await editor.destroy();
  return out;
}

/** A transaction the sync plugin appended. */
const synced = (tr: { getMeta: (key: string) => unknown }) =>
  tr.getMeta(TOC_SYNC_META) === true;

const DOC = [
  "# Setup",
  "",
  "## Install",
  "",
  "#### Deep",
  "",
  "# Setup",
  "",
  "Body text.",
  "",
].join("\n");

const TOC = [
  TOC_COMMENT,
  "- [Setup](#setup)",
  "  - [Install](#install)",
  "    - [Deep](#deep)",
  "- [Setup](#setup-1)",
  "",
].join("\n");

describe("isTocComment", () => {
  it("matches the canonical marker", () => {
    expect(isTocComment(TOC_COMMENT)).toBe(true);
  });

  it("tolerates extra whitespace", () => {
    expect(isTocComment("<!--ken:toc-->")).toBe(true);
    expect(isTocComment("<!--   ken:toc   -->")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isTocComment("<!-- ken:table full -->")).toBe(false);
    expect(isTocComment("<!-- ken:toc full -->")).toBe(false);
    expect(isTocComment("<!-- toc -->")).toBe(false);
    expect(isTocComment(undefined)).toBe(false);
  });
});

describe("tocEntries", () => {
  const entries = (headings: { text: string; level: number }[]) =>
    tocEntries(
      headings.map((h) => ({ ...h, slug: h.text.toLowerCase() })),
    );

  it("nests relative to the shallowest level present", () => {
    expect(
      entries([
        { text: "A", level: 2 },
        { text: "B", level: 3 },
      ]),
    ).toEqual([
      { text: "A", slug: "a", depth: 0, level: 2 },
      { text: "B", slug: "b", depth: 1, level: 3 },
    ]);
  });

  it("collapses skipped levels", () => {
    expect(
      entries([
        { text: "A", level: 1 },
        { text: "B", level: 3 },
        { text: "C", level: 6 },
      ]).map((e) => e.depth),
    ).toEqual([0, 1, 2]);
  });

  it("comes back out of a deep nesting", () => {
    expect(
      entries([
        { text: "A", level: 1 },
        { text: "B", level: 4 },
        { text: "C", level: 2 },
        { text: "D", level: 1 },
      ]).map((e) => e.depth),
    ).toEqual([0, 1, 1, 0]);
  });

  it("keeps document order for repeated levels", () => {
    expect(
      entries([
        { text: "A", level: 2 },
        { text: "B", level: 2 },
      ]).map((e) => e.depth),
    ).toEqual([0, 0]);
  });

  it("drops headings with no text", () => {
    expect(entries([{ text: "", level: 1 }, { text: "A", level: 2 }])).toEqual([
      { text: "A", slug: "a", depth: 0, level: 2 },
    ]);
  });

  it("keeps each heading's own level, which nesting depth is not", () => {
    expect(
      entries([
        { text: "A", level: 2 },
        { text: "B", level: 3 },
      ]).map((e) => e.level),
    ).toEqual([2, 3]);
  });

  it("is empty for a document with no headings", () => {
    expect(tocEntries([])).toEqual([]);
  });
});

describe("markdown round trip", () => {
  it("parses the marker onto the following list", async () => {
    const editor = await makeEditor(`${TOC}\n${DOC}`);
    const doc = editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
    expect(doc.child(0).type.name).toBe("bullet_list");
    expect(doc.child(0).attrs.toc).toBe(true);
    await editor.destroy();
  });

  it("round trips an up-to-date table of contents byte for byte", async () => {
    const md = `${TOC}\n${DOC}`;
    const out = await roundTrip(md);
    expect(out).toBe(md);
    expect(await roundTrip(out)).toBe(md);
  });

  // The editor's list serialization writes a blank line between items (Milkdown
  // stores `spread` as a string, which remark-stringify reads as "loose"), so
  // the expected output here is that existing form, unchanged by this plugin.
  it("leaves a plain bullet list alone", async () => {
    const md = "- one\n\n- two\n";
    const editor = await makeEditor(md);
    const doc = editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
    expect(doc.child(0).attrs.toc).toBe(false);
    expect(editor.action(getMarkdown())).toBe(md);
    await editor.destroy();
  });

  it("leaves a marker that is not followed by a list alone", async () => {
    const md = `${TOC_COMMENT}\n\nJust a paragraph.\n`;
    const editor = await makeEditor(md);
    const doc = editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
    expect(doc.child(0).type.name).not.toBe("bullet_list");
    expect(editor.action(getMarkdown())).toContain("ken:toc");
    await editor.destroy();
  });

  it("rewrites a stale on-disk table of contents when the document opens", async () => {
    const stale = [TOC_COMMENT, "- [Old](#old)", ""].join("\n");
    const out = await roundTrip(`${stale}\n${DOC}`);
    expect(out).toBe(`${TOC}\n${DOC}`);
  });

  it("writes the empty placeholder when there are no headings", async () => {
    const md = `${TOC_COMMENT}\n- [Gone](#gone)\n\nNo headings here.\n`;
    const out = await roundTrip(md);
    expect(out).toBe(
      `${TOC_COMMENT}\n- ${TOC_EMPTY_TEXT}\n\nNo headings here.\n`,
    );
  });

  it("escapes link text that would otherwise be markup", async () => {
    const md = `${TOC_COMMENT}\n- x\n\n# A [b] c\n`;
    const out = await roundTrip(md);
    expect(out).toContain("- [A \\[b\\] c](#a-b-c)");
    expect(await roundTrip(out)).toBe(out);
  });
});

describe("buildTocList", () => {
  it("equals the node parsed from the same markdown", async () => {
    const editor = await makeEditor(`${TOC}\n${DOC}`);
    const { doc, schema } = editor.action(
      (ctx) => ctx.get(editorViewCtx).state,
    );
    const existing = findTocList(doc);
    expect(existing).toBeDefined();
    const built = buildTocList(schema, collectHeadings(doc));
    expect(existing!.node.eq(built)).toBe(true);
    await editor.destroy();
  });
});

describe("live sync", () => {
  it("follows a heading rename with exactly one appended transaction", async () => {
    const editor = await makeEditor(`${TOC}\n${DOC}`);
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      // Rename the last heading: "Setup" -> "Shipping".
      const headings = collectHeadings(view.state.doc);
      const last = headings[headings.length - 1]!;
      const tr = view.state.tr.insertText(
        "Shipping",
        last.pos + 1,
        last.pos + last.size - 1,
      );
      // `applyTransaction` runs the append loop to exhaustion, so a plugin
      // that kept rewriting the list would hang here rather than pass.
      const applied = view.state.applyTransaction(tr);
      expect(applied.transactions.filter(synced).length).toBe(1);
      view.updateState(applied.state);
    });
    expect(editor.action(getMarkdown())).toContain("- [Shipping](#shipping)");
    await editor.destroy();
  });

  it("appends nothing for an edit that leaves the headings alone", async () => {
    const editor = await makeEditor(`${TOC}\n${DOC}`);
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const end = view.state.doc.content.size - 1;
      const applied = view.state.applyTransaction(
        view.state.tr.insertText("!", end),
      );
      expect(applied.transactions.filter(synced).length).toBe(0);
      view.updateState(applied.state);
    });
    expect(editor.action(getMarkdown())).toBe(
      `${TOC}\n${DOC}`.replace("Body text.", "Body text.!"),
    );
    await editor.destroy();
  });

  it("only keeps the first table of contents in sync", async () => {
    const md = `${TOC}\n${DOC}\n${TOC_COMMENT}\n- [Old](#old)\n`;
    const out = await roundTrip(md);
    expect(out).toBe(md);
  });
});

describe("insertTocCommand", () => {
  it("replaces an empty paragraph with the table of contents", async () => {
    const editor = await makeEditor(`${DOC}\n`);
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      // Append an empty paragraph and put the caret in it.
      const end = view.state.doc.content.size;
      const paragraph = view.state.schema.nodes.paragraph!.create();
      const tr = view.state.tr.insert(end, paragraph);
      tr.setSelection(TextSelection.near(tr.doc.resolve(end + 1)));
      view.dispatch(tr);
    });
    editor.action(callCommand(insertTocCommand.key, undefined));
    const out = editor.action(getMarkdown());
    // A table of contents lists what follows it, and at the end of the
    // document nothing does.
    expect(out).toBe(`${DOC}\n${TOC_COMMENT}\n- ${TOC_EMPTY_TEXT}\n`);
    await editor.destroy();
  });

  it("inserts after a block that has content", async () => {
    const editor = await makeEditor("Hello.\n");
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.near(view.state.doc.resolve(1)),
        ),
      );
    });
    editor.action(callCommand(insertTocCommand.key, undefined));
    expect(editor.action(getMarkdown())).toBe(
      `Hello.\n\n${TOC_COMMENT}\n- ${TOC_EMPTY_TEXT}\n`,
    );
    await editor.destroy();
  });
});

describe("headings above the list", () => {
  it("omits a title above the table of contents", async () => {
    const md = ["# Title", "", TOC_COMMENT, "- x", "", "## After", ""].join(
      "\n",
    );
    const out = await roundTrip(md);
    expect(out).toBe(
      ["# Title", "", TOC_COMMENT, "- [After](#after)", "", "## After", ""].join(
        "\n",
      ),
    );
  });

  it("keeps the placeholder when nothing follows the list", async () => {
    const md = ["# Title", "", TOC_COMMENT, "- [Title](#title)", ""].join("\n");
    const out = await roundTrip(md);
    expect(out).toBe(
      ["# Title", "", TOC_COMMENT, `- ${TOC_EMPTY_TEXT}`, ""].join("\n"),
    );
  });

  it("nests relative to the shallowest heading that follows", async () => {
    const md = ["# Title", "", TOC_COMMENT, "- x", "", "## A", "", "### B", ""].join("\n");
    const out = await roundTrip(md);
    expect(out).toContain("- [A](#a)\n  - [B](#b)");
  });
});

describe("rendering", () => {
  it("marks the list non-editable and captioned", async () => {
    const editor = await makeEditor(`${TOC}\n${DOC}`);
    const dom = editor.action((ctx) => ctx.get(editorViewCtx).dom);
    const list = dom.querySelector("ul.ken-toc");
    expect(list).not.toBeNull();
    expect(list?.getAttribute("contenteditable")).toBe("false");
    await editor.destroy();
  });

  it("marks the entries whose heading is an h1", async () => {
    const editor = await makeEditor(`${TOC}\n${DOC}`);
    const dom = editor.action((ctx) => ctx.get(editorViewCtx).dom);
    const list = dom.querySelector("ul.ken-toc")!;
    const marked = [...list.children].map((li) =>
      li.querySelector(`.${TOC_H1_CLASS}`) !== null ||
      li.classList.contains(TOC_H1_CLASS),
    );
    // DOC is two h1s, each with its own nested headings.
    expect(marked).toEqual([true, true]);
    await editor.destroy();
  });

  it("does not mark top-level entries that are not h1s", async () => {
    const md = [TOC_COMMENT, "- x", "", "## A", "", "### B", ""].join("\n");
    const editor = await makeEditor(md);
    const dom = editor.action((ctx) => ctx.get(editorViewCtx).dom);
    const list = dom.querySelector("ul.ken-toc")!;
    expect(list.querySelector(`.${TOC_H1_CLASS}`)).toBeNull();
    await editor.destroy();
  });
});
