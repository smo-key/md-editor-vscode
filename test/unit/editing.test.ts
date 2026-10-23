// The editing UI on the real editor: the slash menu, the shared commands the
// toolbar runs, the table operations, and what each writes to Markdown.
import { describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

import { COMMANDS, command, currentCell, focusCell } from "../../webview/commands";
import { normalizeTrailingNewlines } from "../../webview/markdown/gfmFidelity";
import { filterCommands, slashMatch } from "../../webview/slashMenu";
import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();

type Mounted = Awaited<ReturnType<typeof mountEditor>>;

function viewOf(ed: Mounted): EditorView {
  return ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
}

/** Put the caret right after the first occurrence of `text`. */
function caretAfter(view: EditorView, text: string) {
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return found < 0;
    const i = node.text!.indexOf(text);
    if (i >= 0) found = pos + i + text.length;
    return false;
  });
  if (found < 0) throw new Error(`no text ${text}`);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, found)));
}

async function withEditor(markdown: string, fn: (ed: Mounted, view: EditorView, run: (id: string) => void) => void | Promise<void>) {
  const mounted = await mountEditor(markdown);
  // As the webview writes it (main.ts).
  const ed = { ...mounted, markdown: () => normalizeTrailingNewlines(mounted.markdown()) };
  const view = viewOf(ed);
  // `execute` minus its focus call: focusing in happy-dom fires selectionchange
  // synchronously, which re-enters CodeMirror's views. Chromium covers focus.
  const run = (id: string) =>
    ed.crepe.editor.action((ctx) => {
      const cmd = command(id);
      if (!cmd.isEnabled || cmd.isEnabled(view.state)) cmd.run(ctx, view);
    });
  try {
    await fn(ed, view, run);
  } finally {
    await ed.destroy();
  }
}

describe("slash menu", () => {
  it("triggers on / at the start of a line or after a space only", async () => {
    await withEditor("start\n", (_ed, view) => {
      const type = (text: string) => view.dispatch(view.state.tr.insertText(text));
      caretAfter(view, "start");
      type(" /he");
      expect(slashMatch(view.state)).toMatchObject({ query: "he" });
      type("ading x");
      expect(slashMatch(view.state)).toBeNull();
      type(" and/or");
      expect(slashMatch(view.state)).toBeNull();
    });
  });

  it("triggers inside list items and table cells, not in code", async () => {
    await withEditor("- item\n\n| a |\n| - |\n| b |\n\n```\ncode\n```\n", (_ed, view) => {
      for (const at of ["item", "b", "code"]) {
        caretAfter(view, at);
        view.dispatch(view.state.tr.insertText(" /"));
        expect(!!slashMatch(view.state), at).toBe(at !== "code");
      }
    });
  });

  it("opens on the very keystroke and runs the chosen command", async () => {
    await withEditor("Intro\n\nx\n", (ed, view) => {
      caretAfter(view, "x");
      view.dispatch(view.state.tr.delete(view.state.selection.from - 1, view.state.selection.from));
      view.dispatch(view.state.tr.insertText("/"));
      const menu = document.querySelector<HTMLElement>(".ken-slash-menu")!;
      expect(menu.hidden).toBe(false);
      view.dispatch(view.state.tr.insertText("h2"));
      const items = [...menu.querySelectorAll<HTMLElement>(".ken-slash-item")].map((e) => e.dataset.id);
      expect(items[0]).toBe("heading2");
      view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      expect(menu.hidden).toBe(true);
      view.dispatch(view.state.tr.insertText("Title"));
      expect(ed.markdown()).toBe("Intro\n\n## Title\n");
    });
  });

  describe("Enter runs the highlighted item, not the top one", () => {
    const key = (view: EditorView, k: string) =>
      view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    const open = (view: EditorView, query: string) => {
      // As in Chromium, where the editor has focus while typing.
      view.hasFocus = () => true;
      caretAfter(view, "x");
      view.dispatch(view.state.tr.delete(view.state.selection.from - 1, view.state.selection.from));
      view.dispatch(view.state.tr.insertText(`/${query}`));
      const menu = document.querySelector<HTMLElement>(".ken-slash-menu")!;
      expect(menu.hidden).toBe(false);
      return menu;
    };
    const active = (menu: HTMLElement) => menu.querySelector<HTMLElement>(".ken-slash-item.active")?.dataset.id;

    it("after ArrowDown in the unfiltered menu", async () => {
      await withEditor("Intro\n\nx\n", (ed, view) => {
        const menu = open(view, "");
        for (let i = 0; i < 3; i++) key(view, "ArrowDown");
        expect(active(menu)).toBe("heading3");
        key(view, "Enter");
        expect(menu.hidden).toBe(true);
        view.dispatch(view.state.tr.insertText("Title"));
        expect(ed.markdown()).toBe("Intro\n\n### Title\n");
      });
    });

    it("after ArrowUp, wrapping to the last item", async () => {
      await withEditor("Intro\n\nx\n", (_ed, view) => {
        const menu = open(view, "h");
        const items = [...menu.querySelectorAll<HTMLElement>(".ken-slash-item")].map((e) => e.dataset.id);
        key(view, "ArrowUp");
        expect(active(menu)).toBe(items[items.length - 1]);
      });
    });

    it("after the mouse moves over an item", async () => {
      await withEditor("Intro\n\nx\n", (ed, view) => {
        const menu = open(view, "");
        menu.querySelector<HTMLElement>('.ken-slash-item[data-id="quote"]')!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
        expect(active(menu)).toBe("quote");
        key(view, "Enter");
        view.dispatch(view.state.tr.insertText("Said"));
        expect(ed.markdown()).toBe("Intro\n\n> Said\n");
      });
    });

    // "/table" is also a slash shortcut (slashShortcuts.ts): Enter used to
    // apply it ahead of the menu, whatever was highlighted.
    it("after filtering to an exact shortcut keyword, then ArrowDown", async () => {
      await withEditor("# Intro\n\nx\n", (ed, view) => {
        const menu = open(view, "table");
        expect(active(menu)).toBe("table");
        key(view, "ArrowDown");
        expect(active(menu)).toBe("toc");
        key(view, "Enter");
        expect(menu.hidden).toBe(true);
        expect(ed.markdown()).not.toMatch(/\|/);
        expect(ed.markdown()).toMatch(/<!-- ken:toc -->/);
      });
    });

    it("with the highlight left on top, an exact keyword still runs its block", async () => {
      await withEditor("Intro\n\nx\n", (ed, view) => {
        open(view, "h2");
        key(view, "Enter");
        view.dispatch(view.state.tr.insertText("Title"));
        expect(ed.markdown()).toBe("Intro\n\n## Title\n");
      });
    });

    it("/hr then Enter leaves a fresh line after the rule, as the shortcut did", async () => {
      await withEditor("Intro\n\nx\n\nEnd\n", (ed, view) => {
        const menu = open(view, "hr");
        expect(active(menu)).toBe("divider");
        key(view, "Enter");
        view.dispatch(view.state.tr.insertText("Next"));
        expect(ed.markdown()).toMatch(/^Intro\n\n(\*\*\*|---)\n\nNext\n\nEnd\n$/);
      });
    });

    it("Tab still runs the highlighted item", async () => {
      await withEditor("Intro\n\nx\n", (ed, view) => {
        const menu = open(view, "");
        key(view, "ArrowDown");
        expect(active(menu)).toBe("heading1");
        key(view, "Tab");
        view.dispatch(view.state.tr.insertText("Top"));
        expect(ed.markdown()).toBe("Intro\n\n# Top\n");
      });
    });
  });

  it("filters by label, then keywords", () => {
    const slash = COMMANDS.filter((c) => c.slash);
    expect(filterCommands(slash, "tab")[0].id).toBe("table");
    expect(filterCommands(slash, "todo")[0].id).toBe("task-list");
    expect(filterCommands(slash, "h3")[0].id).toBe("heading3");
    expect(filterCommands(slash, "mermaid")[0].id).toBe("mermaid");
    expect(filterCommands(slash, "zzz")).toEqual([]);
  });
});

describe("toolbar commands", () => {
  it.each([
    ["bold", "**word**"],
    ["italic", "*word*"],
    ["underline", "<ins>word</ins>"],
    ["strike", "~~word~~"],
    ["inline-code", "`word`"],
  ])("%s formats the selection", async (id, expected) => {
    await withEditor("a word here\n", (ed, view, run) => {
      caretAfter(view, "a ");
      const from = view.state.selection.from;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + 4)));
      run(id);
      expect(ed.markdown()).toBe(`a ${expected} here\n`);
      expect(command(id).isActive!(view.state)).toBe(true);
    });
  });

  it.each([
    ["heading1", "# line\n"],
    ["heading3", "### line\n"],
    ["bullet-list", "- line\n"],
    ["ordered-list", "1. line\n"],
    ["task-list", "- [ ] line\n"],
    ["quote", "> line\n"],
    ["code-block", "```\nline\n```\n"],
  ])("%s converts the current block, and toggles back", async (id, expected) => {
    await withEditor("line\n", (ed, view, run) => {
      caretAfter(view, "line");
      run(id);
      expect(ed.markdown()).toBe(expected);
      expect(command(id).isActive!(view.state)).toBe(true);
      // happy-dom fires selectionchange synchronously, which re-enters the
      // code block's CodeMirror view; that toggle is checked in Chromium
      // (harness/check-editing.mjs) instead.
      if (id === "code-block") return;
      run(id);
      expect(ed.markdown()).toBe("line\n");
    });
  });

  it("switches between list kinds in place", async () => {
    await withEditor("- one\n- two\n", (ed, view, run) => {
      caretAfter(view, "two");
      run("ordered-list");
      expect(ed.markdown()).toBe("1. one\n2. two\n");
      run("task-list");
      expect(ed.markdown()).toBe("- [ ] one\n- [ ] two\n");
      run("bullet-list");
      expect(ed.markdown()).toBe("- one\n- two\n");
    });
  });

  it.each([
    ["table", /^\| +\| +\| +\|\n\| :?-+ \| :?-+ \| :?-+ \|\n/],
    ["divider", /^text\n\n-{3}|^text\n\n\*{3}/],
    ["toc", /<!-- ken:toc -->/],
    ["alert-warning", /> \[!WARNING\]/],
  ])("%s inserts a block", async (id, expected) => {
    await withEditor(id === "table" ? "\n" : "text\n", (ed, view, run) => {
      if (id !== "table") caretAfter(view, "text");
      run(id);
      expect(ed.markdown()).toMatch(expected);
    });
  });

  it("indents and outdents list items, only where possible", async () => {
    await withEditor("- one\n- two\n", (ed, view, run) => {
      caretAfter(view, "one");
      expect(command("indent").isEnabled!(view.state)).toBe(false);
      caretAfter(view, "two");
      expect(command("indent").isEnabled!(view.state)).toBe(true);
      run("indent");
      expect(ed.markdown()).toBe("- one\n  - two\n");
      run("outdent");
      expect(ed.markdown()).toBe("- one\n- two\n");
    });
    await withEditor("text\n", (_ed, view) => {
      caretAfter(view, "text");
      expect(command("indent").isEnabled!(view.state)).toBe(false);
      expect(command("outdent").isEnabled!(view.state)).toBe(false);
    });
  });

  it("Tab / Shift+Tab change a heading's level by one", async () => {
    await withEditor("## Title\n\nText\n", (ed, view) => {
      const key = (k: string, shift = false) =>
        view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true, cancelable: true }));
      caretAfter(view, "Title");
      key("Tab");
      expect(ed.markdown()).toBe("### Title\n\nText\n");
      key("Tab", true);
      key("Tab", true);
      key("Tab", true);
      expect(ed.markdown()).toBe("# Title\n\nText\n");
      for (let i = 0; i < 8; i++) key("Tab");
      expect(ed.markdown()).toBe("###### Title\n\nText\n");
    });
  });

  it("undo and redo", async () => {
    await withEditor("a\n", (ed, view, run) => {
      caretAfter(view, "a");
      view.dispatch(view.state.tr.insertText("bc"));
      expect(command("undo").isEnabled!(view.state)).toBe(true);
      run("undo");
      expect(ed.markdown()).toBe("a\n");
      run("redo");
      expect(ed.markdown()).toBe("abc\n");
    });
  });

  it("mounts a toolbar that follows the caret into tables", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const ed = await mountEditor("text\n\n| a | b |\n| - | - |\n| 1 | 2 |\n", { toolbarHost: host });
    const view = viewOf(ed);
    const toolbar = host.querySelector<HTMLElement>(".ken-toolbar")!;
    caretAfter(view, "text");
    expect(toolbar.dataset.mode).toBe("main");
    caretAfter(view, "1");
    expect(toolbar.dataset.mode).toBe("table");
    host.querySelector<HTMLButtonElement>('[data-id="row-below"]')!.click();
    expect(ed.markdown()).toContain("| 1 | 2 |\n|   |   |");
    // Heading control: the menu lists Text and H1–H6; picking one applies it
    // and becomes the button's level.
    caretAfter(view, "text");
    expect(toolbar.dataset.mode).toBe("main");
    host.querySelector<HTMLButtonElement>('[data-id="heading-menu"]')!.click();
    const items = [...document.querySelectorAll<HTMLElement>(".ken-heading-item")].map((e) => e.dataset.id);
    expect(items).toEqual(["paragraph", "heading1", "heading2", "heading3", "heading4", "heading5", "heading6"]);
    document.querySelector<HTMLButtonElement>('.ken-heading-item[data-id="heading6"]')!.click();
    expect(ed.markdown().startsWith("###### text")).toBe(true);
    expect(document.querySelector(".ken-heading-menu")).toBeNull();
    const main = host.querySelector<HTMLButtonElement>('[data-id="heading"]')!;
    expect(main.dataset.level).toBe("6");
    expect(main.classList.contains("active")).toBe(true);
    main.click();
    expect(ed.markdown().startsWith("text")).toBe(true);
    expect(main.dataset.level).toBe("6");
    expect(main.classList.contains("active")).toBe(false);
    await ed.destroy();
    host.remove();
  });
});

describe("tables", () => {
  const TABLE = "| H1 | H2 | H3 |\n| -- | -- | -- |\n| a  | b  | c  |\n| d  | e  | f  |\n";
  const rows = (md: string) =>
    md
      .trim()
      .split("\n")
      .filter((l) => !/^\| *:?-/.test(l))
      .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()).join(","));

  it.each([
    ["row-above", "b", ["H1,H2,H3", ",,", "a,b,c", "d,e,f"]],
    ["row-below", "b", ["H1,H2,H3", "a,b,c", ",,", "d,e,f"]],
    ["col-left", "b", ["H1,,H2,H3", "a,,b,c", "d,,e,f"]],
    ["col-right", "b", ["H1,H2,,H3", "a,b,,c", "d,e,,f"]],
    ["row-down", "b", ["H1,H2,H3", "d,e,f", "a,b,c"]],
    ["row-up", "e", ["H1,H2,H3", "d,e,f", "a,b,c"]],
    ["col-left-move", "b", ["H2,H1,H3", "b,a,c", "e,d,f"]],
    ["col-right-move", "b", ["H1,H3,H2", "a,c,b", "d,f,e"]],
    ["delete-row", "b", ["H1,H2,H3", "d,e,f"]],
    ["delete-col", "b", ["H1,H3", "a,c", "d,f"]],
  ])("%s (caret in %s)", async (id, at, expected) => {
    await withEditor(TABLE, (ed, view, run) => {
      caretAfter(view, at);
      run(id);
      expect(rows(ed.markdown())).toEqual(expected);
      // The caret stays in the table for the next action.
      expect(currentCell(view.state)).not.toBeNull();
    });
  });

  it("aligns a whole column", async () => {
    await withEditor(TABLE, (ed, view, run) => {
      caretAfter(view, "e");
      run("align-right");
      expect(ed.markdown().split("\n")[1]).toMatch(/^\| -+ \| -+: \| -+ \|$/);
      expect(command("align-right").isActive!(view.state)).toBe(true);
      run("align-center");
      expect(ed.markdown().split("\n")[1]).toMatch(/^\| -+ \| :-+: \| -+ \|$/);
    });
  });

  it("toggles full width", async () => {
    await withEditor(TABLE, (ed, view, run) => {
      caretAfter(view, "e");
      run("table-width");
      expect(ed.markdown()).toMatch(/<!-- ken:table full -->/);
      expect(command("table-width").isActive!(view.state)).toBe(true);
    });
  });

  it("deletes the table", async () => {
    await withEditor(`before\n\n${TABLE}`, (ed, view, run) => {
      caretAfter(view, "d");
      run("delete-table");
      expect(ed.markdown()).toBe("before\n");
    });
  });

  it("keeps the header row in place", async () => {
    await withEditor(TABLE, (_ed, view) => {
      caretAfter(view, "H2");
      for (const id of ["row-above", "row-up", "row-down", "delete-row"]) {
        expect(command(id).isEnabled!(view.state), id).toBe(false);
      }
      expect(command("row-below").isEnabled!(view.state)).toBe(true);
    });
  });

  it("Tab in the last cell adds a row; Enter moves down, then leaves the table", async () => {
    await withEditor(TABLE, (ed, view) => {
      const key = (key: string) =>
        view.dom.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      caretAfter(view, "f");
      key("Tab");
      view.dispatch(view.state.tr.insertText("g"));
      expect(rows(ed.markdown()).at(-1)).toBe("g,,");
      caretAfter(view, "b");
      key("Enter");
      view.dispatch(view.state.tr.insertText("!"));
      expect(rows(ed.markdown())[2]).toBe("d,e!,f");
      caretAfter(view, "g");
      key("Enter");
      expect(currentCell(view.state)).toBeNull();
      view.dispatch(view.state.tr.insertText("after"));
      expect(ed.markdown().trim().endsWith("after")).toBe(true);
    });
  });

  it("writes empty cells as empty, not <br />", async () => {
    await withEditor(TABLE, (ed, view, run) => {
      caretAfter(view, "b");
      run("row-below");
      expect(ed.markdown()).not.toContain("<br");
    });
  });

  it("focusCell clamps to the table", async () => {
    await withEditor(TABLE, (_ed, view) => {
      caretAfter(view, "a");
      const c = currentCell(view.state)!;
      focusCell(view, c.tableStart, 99, 99);
      expect(currentCell(view.state)).toMatchObject({ row: 2, col: 2 });
    });
  });
});
