// The blank lines between the frontmatter's closing `---` and the body are
// not part of the Markdown the editor sees (its parser drops them), so they
// are set aside with the frontmatter and written back exactly.
import { editorViewCtx } from "@milkdown/kit/core";
import type { EditorView } from "@milkdown/kit/prose/view";
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { joinDocument, splitDocument } from "../../webview/frontmatterModel";
import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();

/** Open `text` the way main.ts does, type at the end of the body, save it back. */
async function editBody(text: string, typed = "!"): Promise<string> {
  const { front, gap, body } = splitDocument(text);
  const ed = await mountEditor(body);
  const view: EditorView = ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
  view.dispatch(view.state.tr.insertText(typed, view.state.doc.content.size - 1));
  const out = joinDocument(front, gap, ed.markdown());
  await ed.destroy();
  return out;
}

describe("separator between frontmatter and body", () => {
  it("keeps one blank line", async () => {
    expect(await editBody("---\ntitle: A\n---\n\n# Sample document\n")).toBe("---\ntitle: A\n---\n\n# Sample document!\n");
  });

  it("keeps no blank line", async () => {
    expect(await editBody("---\ntitle: A\n---\n# Sample document\n")).toBe("---\ntitle: A\n---\n# Sample document!\n");
  });

  it("keeps several blank lines, whitespace and CRLF", async () => {
    const { front, gap } = splitDocument("---\r\na: 1\r\n---\r\n\r\n  \r\n\r\nBody\r\n");
    expect(front).toBe("---\r\na: 1\r\n---\r\n");
    expect(gap).toBe("\r\n  \r\n\r\n");
    expect(await editBody("---\na: 1\n---\n\n\n\nBody\n")).toBe("---\na: 1\n---\n\n\n\nBody!\n");
  });

  it("splits a document without frontmatter or body", () => {
    expect(splitDocument("# Doc\n")).toEqual({ front: "", gap: "", body: "# Doc\n" });
    expect(splitDocument("---\na: 1\n---\n\n")).toEqual({ front: "---\na: 1\n---\n", gap: "\n", body: "" });
  });

  it("keeps the sample fixture's blank line", async () => {
    const sample = readFileSync(resolve(__dirname, "../fixtures/sample.md"), "utf8");
    expect(sample).toMatch(/^---\n[\s\S]*?\n---\n\n#/);
    const out = await editBody(sample, "");
    expect(out.slice(0, sample.indexOf("#"))).toBe(sample.slice(0, sample.indexOf("#")));
  });
});
