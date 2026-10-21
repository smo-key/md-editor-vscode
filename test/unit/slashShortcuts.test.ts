import { beforeAll, describe, expect, it } from "vitest";
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  remarkStringifyOptionsCtx,
  rootCtx,
} from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { TextSelection } from "@milkdown/kit/prose/state";
import { getMarkdown } from "@milkdown/kit/utils";

import { githubAlertPlugins } from "../../webview/markdown/githubAlert";
import {
  parseSlashCommand,
  parseSlashShortcut,
  slashCommandTransaction,
  SLASH_SHORTCUT_RE,
} from "../../webview/markdown/slashShortcuts";
import { tocPlugins } from "../../webview/markdown/toc";

describe("parseSlashShortcut", () => {
  it("parses every heading level", () => {
    for (let level = 1; level <= 6; level++) {
      expect(parseSlashShortcut(`/h${level} `)).toEqual({
        type: "heading",
        level,
      });
    }
  });

  it("parses the simple block types", () => {
    expect(parseSlashShortcut("/quote ")).toEqual({ type: "quote" });
    expect(parseSlashShortcut("/code ")).toEqual({ type: "code" });
    expect(parseSlashShortcut("/divider ")).toEqual({ type: "divider" });
    expect(parseSlashShortcut("/bullet ")).toEqual({ type: "bulletList" });
    expect(parseSlashShortcut("/number ")).toEqual({ type: "orderedList" });
    expect(parseSlashShortcut("/todo ")).toEqual({ type: "taskList" });
    expect(parseSlashShortcut("/toc ")).toEqual({ type: "toc" });
  });

  it("parses the five alert kinds", () => {
    for (const kind of [
      "note",
      "tip",
      "important",
      "warning",
      "caution",
    ] as const) {
      expect(parseSlashShortcut(`/${kind} `)).toEqual({ type: "alert", kind });
    }
  });

  it("is case-insensitive", () => {
    expect(parseSlashShortcut("/H3 ")).toEqual({ type: "heading", level: 3 });
    expect(parseSlashShortcut("/Quote ")).toEqual({ type: "quote" });
  });

  it("parses the aliases", () => {
    expect(parseSlashShortcut("/hr ")).toEqual({ type: "divider" });
    expect(parseSlashShortcut("/ul ")).toEqual({ type: "bulletList" });
    expect(parseSlashShortcut("/ol ")).toEqual({ type: "orderedList" });
    expect(parseSlashShortcut("/task ")).toEqual({ type: "taskList" });
    expect(parseSlashShortcut("/checklist ")).toEqual({ type: "taskList" });
    expect(parseSlashShortcut("/table ")).toEqual({ type: "table" });
  });

  it("requires the trailing space", () => {
    expect(parseSlashShortcut("/h1")).toBeNull();
    expect(parseSlashShortcut("/quote")).toBeNull();
  });

  it("rejects unknown keywords", () => {
    expect(parseSlashShortcut("/h7 ")).toBeNull();
    expect(parseSlashShortcut("/tocs ")).toBeNull();
    expect(parseSlashShortcut("/heading ")).toBeNull();
    expect(parseSlashShortcut("/ ")).toBeNull();
    expect(parseSlashShortcut("")).toBeNull();
  });

  it("rejects text around the shortcut", () => {
    expect(parseSlashShortcut("hello /h1 ")).toBeNull();
    expect(parseSlashShortcut("/h1 x ")).toBeNull();
    expect(parseSlashShortcut(" /h1 ")).toBeNull();
  });

  it("exposes a regex anchored to a whole block", () => {
    expect(SLASH_SHORTCUT_RE.test("/h1 ")).toBe(true);
    expect(SLASH_SHORTCUT_RE.test("a/h1 ")).toBe(false);
  });
});

describe("parseSlashCommand", () => {
  it("parses a bare shortcut, as typed before Space or Enter", () => {
    expect(parseSlashCommand("/h2")).toEqual({ type: "heading", level: 2 });
    expect(parseSlashCommand("/toc")).toEqual({ type: "toc" });
    expect(parseSlashCommand("/Table")).toEqual({ type: "table" });
  });

  it("rejects a trailing space, text around it and unknown keywords", () => {
    expect(parseSlashCommand("/h2 ")).toBeNull();
    expect(parseSlashCommand("x /h2")).toBeNull();
    expect(parseSlashCommand("/h7")).toBeNull();
    expect(parseSlashCommand("/tab")).toBeNull();
  });
});

// happy-dom lacks the layout APIs ProseMirror's view calls; stub them, as
// toc.test.ts does.
beforeAll(() => {
  const range = globalThis.Range.prototype as unknown as {
    getClientRects?: () => DOMRect[];
    getBoundingClientRect?: () => DOMRect;
  };
  if (!range.getClientRects) range.getClientRects = () => [];
  if (!range.getBoundingClientRect)
    range.getBoundingClientRect = () => ({}) as DOMRect;
  const el = globalThis.Element.prototype as unknown as {
    getClientRects?: () => DOMRect[];
  };
  if (!el.getClientRects) el.getClientRects = () => [];
});

/**
 * Put `command` in its own paragraph after "Intro", with the cursor at its
 * end, and press Space/Enter via the transaction the key handler runs.
 */
async function pressAfter(command: string) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  let ctxRef: Ctx | undefined;
  const editor = await Editor.make()
    .config((ctx) => {
      ctxRef = ctx;
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, `# Intro\n\n${command}\n\n## Later\n`);
      ctx.update(remarkStringifyOptionsCtx, (opts) => ({
        ...opts,
        bullet: "-" as const,
      }));
    })
    .use(commonmark)
    .use(gfm)
    .use(githubAlertPlugins)
    .use(tocPlugins)
    .create();
  const ctx = ctxRef!;
  const view = ctx.get(editorViewCtx);
  const para = view.state.doc.child(1);
  const end = view.state.doc.child(0).nodeSize + para.nodeSize - 1;
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, end)),
  );
  const tr = slashCommandTransaction(ctx, view.state);
  if (tr) view.dispatch(tr);
  const markdown = editor.action(getMarkdown());
  const cursorIn = view.state.selection.$from.parent.type.name;
  await editor.destroy();
  return { handled: !!tr, markdown, cursorIn };
}

describe("slashCommandTransaction", () => {
  it("turns /h1 into a heading", async () => {
    const { handled, markdown, cursorIn } = await pressAfter("/h1");
    expect(handled).toBe(true);
    expect(cursorIn).toBe("heading");
    expect(markdown).toBe("# Intro\n\n#\n\n## Later\n");
  });

  it("turns /toc into a table of contents of the headings after it", async () => {
    const { handled, markdown } = await pressAfter("/toc");
    expect(handled).toBe(true);
    expect(markdown).toContain("<!-- ken:toc -->\n- [Later](#later)");
  });

  it("turns /hr into a divider", async () => {
    const { handled, markdown } = await pressAfter("/hr");
    expect(handled).toBe(true);
    expect(markdown).toMatch(/# Intro\n\n(---|\*\*\*)\n/);
  });

  it("turns /table into a 3x3 table with the cursor in it", async () => {
    const { handled, markdown, cursorIn } = await pressAfter("/table");
    expect(handled).toBe(true);
    expect(cursorIn).toBe("paragraph");
    const rows = markdown.split("\n").filter((l) => l.startsWith("|"));
    expect(rows).toHaveLength(4); // header, delimiter, two body rows
  });

  it("makes /todo a bulleted task, not a numbered one", async () => {
    const { handled, markdown } = await pressAfter("/todo");
    expect(handled).toBe(true);
    expect(markdown).toContain("- [ ]");
    expect(markdown).not.toMatch(/1\. \[ \]/);
  });

  it("wraps /ol and /ul in lists", async () => {
    expect((await pressAfter("/ol")).markdown).toMatch(/\n1\. /);
    expect((await pressAfter("/ul")).markdown).toMatch(/\n- (?!\[)/);
  });

  it("turns /note into an alert", async () => {
    const { handled, markdown } = await pressAfter("/note");
    expect(handled).toBe(true);
    expect(markdown).toContain("> [!NOTE]");
  });

  it("leaves text that is not exactly a shortcut alone", async () => {
    expect((await pressAfter("/tab")).handled).toBe(false);
    expect((await pressAfter("see /h1")).handled).toBe(false);
  });
});
