// The @ menu: find a project file by name and link to it by relative path.
import { afterEach, describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

import { rankFiles } from "../../src/fileRank";
import { mentionMatch, type FileHit } from "../../webview/fileMention";
import { normalizeTrailingNewlines } from "../../webview/markdown/gfmFidelity";
import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();

describe("ranking files (src/fileRank.ts)", () => {
  const files = ["README.md", "docs/readme-old.md", "docs/guide/setup.md", "src/reader.ts", "assets/logo.png", "notes/area51.md"];
  it("puts name prefixes first, then names containing it, then paths, then scattered letters", () => {
    expect(rankFiles(files, "rea")).toEqual(["README.md", "src/reader.ts", "docs/readme-old.md", "notes/area51.md"]);
    expect(rankFiles(files, "gst")).toEqual(["docs/guide/setup.md"]);
  });
  it("prefers files near the document when nothing is typed", () => {
    expect(rankFiles(files, "", "docs").slice(0, 2)).toEqual(["docs/readme-old.md", "README.md"]);
  });
});

describe("the @ menu", () => {
  afterEach(() => document.querySelectorAll(".ken-mention-menu").forEach((m) => m.remove()));

  it("opens after a space, not inside an email address", async () => {
    const ed = await mountEditor("x\n");
    const view = ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
    const type = (text: string) => view.dispatch(view.state.tr.insertText(text));
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    type(" see @rea");
    expect(mentionMatch(view.state)?.query).toBe("rea");
    type(" me@example");
    expect(mentionMatch(view.state)).toBeNull();
    await ed.destroy();
  });

  it("links the chosen file by its relative path, encoded", async () => {
    const queries: string[] = [];
    const hits: FileHit[] = [{ path: "../docs/Read Me.md", name: "Read Me.md", dir: "docs" }];
    const ed = await mountEditor("See\n", {
      fileMention: {
        search: async (q) => {
          queries.push(q);
          return hits;
        },
      },
    });
    const view: EditorView = ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 4)).insertText(" @read"));
    await new Promise((r) => setTimeout(r, 120));
    const menu = document.querySelector<HTMLElement>(".ken-mention-menu")!;
    expect(menu.hidden).toBe(false);
    expect(menu.textContent).toContain("Read Me.md");
    expect(queries).toEqual(["read"]);
    view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(normalizeTrailingNewlines(ed.markdown())).toBe("See [Read Me.md](../docs/Read%20Me.md)\n");
    expect(menu.hidden).toBe(true);
    await ed.destroy();
  });
});
