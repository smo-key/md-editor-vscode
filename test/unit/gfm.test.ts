// GitHub-flavoured Markdown through the editor exactly as it ships
// (webview/editorSetup.ts): every construct renders as the right node, and
// saving writes it back without changing what GitHub would show.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { stubLayout } from "./editorEnv";
import { buildEditor } from "../../webview/editorSetup";
import { isSelfContained } from "../../webview/markdown/htmlView";

stubLayout();

async function load(markdown: string) {
  const root = document.createElement("div");
  document.body.append(root);
  const crepe = buildEditor({ root, markdown });
  await crepe.create();
  const types = new Set<string>();
  const marks = new Set<string>();
  return {
    root,
    markdown: () => crepe.getMarkdown(),
    collect(view: { state: { doc: { descendants: (f: (n: { type: { name: string }; marks: { type: { name: string } }[] }) => void) => void } } }) {
      view.state.doc.descendants((n) => {
        types.add(n.type.name);
        for (const m of n.marks) marks.add(m.type.name);
      });
      return { types, marks };
    },
    crepe,
    // Crepe's list items dispatch on an animation frame; let them settle first.
    destroy: async () => {
      for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      await crepe.destroy();
    },
  };
}

async function nodeTypes(markdown: string) {
  const ed = await load(markdown);
  const { editorViewCtx } = await import("@milkdown/kit/core");
  const view = ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
  const result = ed.collect(view as never);
  await ed.destroy();
  return result;
}

async function roundTrip(markdown: string): Promise<string> {
  const ed = await load(markdown);
  const out = ed.markdown();
  await ed.destroy();
  return out;
}

const fixture = readFileSync(join(__dirname, "../fixtures/gfm.md"), "utf8");

describe("GFM rendering", () => {
  it("parses every GFM construct into its own node or mark", async () => {
    const { types, marks } = await nodeTypes(fixture);
    for (const t of [
      "heading",
      "paragraph",
      "blockquote",
      "github_alert",
      "code_block",
      "hr",
      "hardbreak",
      "bullet_list",
      "ordered_list",
      "list_item",
      "table",
      "table_header_row",
      "table_row",
      "table_header",
      "table_cell",
      "footnote_reference",
      "footnote_definition",
      "html",
      "image-block",
    ]) {
      expect(types, t).toContain(t);
    }
    for (const m of ["strong", "emphasis", "strike_through", "inlineCode", "link"]) {
      expect(marks, m).toContain(m);
    }
  });

  it("renders task lists with checkboxes", async () => {
    const ed = await load("- [ ] open\n- [x] done\n");
    expect(ed.root.querySelectorAll(".label.unchecked").length).toBe(1);
    expect(ed.root.querySelectorAll(".label.checked").length).toBe(1);
    await ed.destroy();
  });

  it("renders autolink literals as links", async () => {
    const ed = await load("See https://github.com, www.example.com and mail@example.com.\n");
    const hrefs = [...ed.root.querySelectorAll(".ProseMirror a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://github.com", "http://www.example.com", "mailto:mail@example.com"]);
    await ed.destroy();
  });

  it("keeps table column alignment", async () => {
    const out = await roundTrip("| L | C | R |\n| :- | :-: | -: |\n| a | b | c |\n");
    expect(out).toMatch(/\| :-+ \| :-+: \| -+: \|/);
  });

  it("renders self-contained HTML and keeps fragments as source", async () => {
    const ed = await load('<p align="center"><img src="https://example.com/x.png" alt="logo"></p>\n\nInline <kbd>Ctrl</kbd> key.\n');
    expect(ed.root.querySelector(".ken-html-rendered img[alt=logo]")).not.toBeNull();
    expect(ed.root.querySelectorAll(".ken-html-raw").length).toBe(2);
    await ed.destroy();
  });

  it("sanitizes rendered HTML", async () => {
    const ed = await load('<div><img src="x.png" onerror="alert(1)"><script>alert(2)</script></div>\n');
    const rendered = ed.root.querySelector(".ken-html-rendered")!;
    expect(rendered.querySelector("img")?.getAttribute("src")).toBe("x.png");
    expect(rendered.innerHTML).not.toMatch(/onerror|<script/);
    await ed.destroy();
  });
});

describe("GFM round-trip", () => {
  it("is stable: a second save changes nothing", async () => {
    const once = await roundTrip(fixture);
    expect(await roundTrip(once)).toBe(once);
  });

  it.each([
    ["tight bullet list with nesting", "- one\n- two\n  - nested\n    1. deep\n"],
    ["tight ordered list with nesting", "1. a\n2. b\n   - x\n"],
    ["loose list", "- one\n\n- two\n"],
    ["task list", "- [ ] open\n- [x] done\n  - [ ] nested\n"],
    ["strikethrough", "~~gone~~ text\n"],
    ["footnotes", "Claim.[^1]\n\n[^1]: Source.\n"],
    ["alert", "> [!NOTE]\n> Useful.\n"],
    ["image with alt text", '![A diagram](https://example.com/d.png "Caption")\n'],
    ["image without alt text", "![](https://example.com/d.png)\n"],
    ["fenced code", "```ts\nconst x = 1;\n```\n"],
    ["table", "| a | b |\n| - | - |\n| 1 | 2 |\n"],
    ["block html", "<details>\n<summary>More</summary>\n\nHidden.\n\n</details>\n"],
    ["inline html", "Press <kbd>Ctrl</kbd>.\n"],
    ["frontmatter-free comment", "<!-- note to self -->\n\nText.\n"],
  ])("%s survives unchanged", async (_name, md) => {
    expect(await roundTrip(md)).toBe(md);
  });
});

describe("isSelfContained", () => {
  it.each([
    ['<p align="center"><img src="a.png"></p>', true],
    ["<br>", true],
    ["<img src=a.png />", true],
    ["<kbd>Ctrl</kbd>", true],
    ["<details>", false],
    ["</details>", false],
    ["<details>\n<summary>x</summary>", false],
    ["<!-- c -->", false],
    ["<b>a</i>", false],
  ])("%s → %s", (html, expected) => {
    expect(isSelfContained(html)).toBe(expected);
  });
});
