// GitHub-flavoured Markdown through the editor exactly as it ships
// (webview/editorSetup.ts): every construct renders as the right node, and
// saving writes it back without changing what GitHub would show.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { stubLayout } from "./editorEnv";
import { buildEditor } from "../../webview/editorSetup";
import { isSelfContained } from "../../webview/markdown/htmlView";
import { normalizeTrailingNewlines } from "../../webview/markdown/gfmFidelity";

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
  // As the webview writes it (main.ts), without the trailing empty paragraph.
  const out = normalizeTrailingNewlines(ed.markdown());
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

// Milkdown writes each text node on its own and moves the spaces at a
// mark's edges out of it, so one span around another mark used to come back
// split: `*a https://a.com/x b*` as `*a* *https://a.com/x* *b*`.
describe("one span around another mark", () => {
  it.each([
    ["emphasis around a bare literal", "*a https://a.com/x b*\n"],
    ["underscore emphasis around a bare literal", "_a https://a.com/x b_\n"],
    ["strong around a bare literal", "**a https://a.com/x b**\n"],
    ["strikethrough around a bare literal", "~~a https://a.com/x b~~\n"],
    ["emphasis around a literal with an underscore", "*a https://a.com/x_y b*\n"],
    ["emphasis around an angle autolink", "*a <https://a.com> b*\n"],
    ["emphasis around an inline link", "*a [t](https://a.com) b*\n"],
    ["emphasis around two links", "*a [x](u) [y](u) b*\n"],
    ["emphasis ending in a link", "*a [t](u)*\n"],
    ["emphasis around inline code", "*a `c` b*\n"],
    ["strong around inline code", "**a `c` b**\n"],
    ["emphasis around strong", "*a **b** c*\n"],
    ["strong around emphasis", "**a *b* c**\n"],
    ["strikethrough around strong", "~~a **b** c~~\n"],
    ["strong ending in emphasis", "**a *b***\n"],
    ["emphasis ending in strong", "*a **b***\n"],
    ["a link around emphasis", "[a *b* c](https://u.com)\n"],
    ["emphasis around underline", "*a <ins>u</ins> b*\n"],
    ["underline around emphasis", "<ins>a *b* c</ins>\n"],
    ["emphasis around math", "*a $x$ b*\n"],
    ["emphasis around code in a table cell", "| *a `c` b* | x |\n| --------- | - |\n"],
    // Spans the user wrote apart stay apart.
    ["two emphasis spans with a space between", "*a* *b*\n"],
    ["two spans, different markers", "*a*_b_\n"],
    ["emphasis, strong, emphasis", "*a* **b** *c*\n"],
    ["strong emphasis next to emphasis", "***a*** *b*\n"],
    ["emphasis on both sides of a literal", "*a* https://a.com *b*\n"],
    ["emphasis on both sides of code", "*x* `c` *y*\n"],
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

describe("underline (<ins>)", () => {
  it.each([
    ["Some <ins>underlined</ins> text.\n", "Some <ins>underlined</ins> text.\n"],
    ["Old <u>style</u> and **<ins>bold under</ins>** mix.\n", "Old <u>style</u> and **<ins>bold under</ins>** mix.\n"],
    ["Lone <ins> tag.\n", "Lone <ins> tag.\n"],
    ["Nested <ins>a <ins>b</ins> c</ins>.\n", "Nested <ins>a b c</ins>.\n"],
  ])("%j round-trips as %j", async (md, expected) => {
    expect(await roundTrip(md)).toBe(expected);
  });

  it("renders as an underline mark", async () => {
    const ed = await load("Some <ins>underlined</ins> text.\n");
    expect(ed.root.querySelector(".ProseMirror u.ken-underline")?.textContent).toBe("underlined");
    await ed.destroy();
  });
});

describe("link form fidelity", () => {
  const lucid = "https://lucid.app/lucidchart/abc-123/edit?viewport_loc=1&invitationId=inv_x";
  it.each([
    ["bare literal alone", `${lucid}\n`],
    ["literal mid-sentence", `See ${lucid} inline.\n`],
    ["www literal", "Go to www.example.com today.\n"],
    ["email literal", "Mail mail@example.com now.\n"],
    ["angle autolink", "<https://example.com/view>\n"],
    ["angle email autolink", "<mail@example.com>\n"],
    ["inline link with the url as text", "[https://x.com/a](https://x.com/a)\n"],
    ["inline link with text", "[Architecture](https://example.com/edit)\n"],
    ["literal before a full stop", "Read https://example.com.\n"],
    ["literal before a comma", "Read https://example.com, then go.\n"],
    ["literal in parentheses", "Docs (https://example.com) here.\n"],
    ["literal before a colon", "At https://example.com: done\n"],
    ["literal before ! and ?", "Wow https://example.com! Or https://example.org?\n"],
    ["literal before ; and in quotes", "A https://a.com; 'https://b.com' \"https://c.com\"\n"],
    ["literal ending in an entity-like name before ;", "A <https://a.com/?x&amp>; b\n"],
    ["email literal in quotes", "\"mail@c.com\" and 'mail@d.com'\n"],
    ["literal with balanced parentheses", "(https://x.com/a_(b))\n"],
    ["literal with a query", "https://x.com/?a=1&b=2#top\n"],
    ["literal in emphasis", "*https://example.com* and **https://example.org**\n"],
    ["literal in strikethrough", "~~https://example.com~~\n"],
    ["literal in a list item", "- https://example.com\n- [https://y.com](https://y.com)\n"],
    ["literal in a blockquote", "> https://example.com\n"],
    [
      "literal in a table cell",
      "| a                   | b               |\n| ------------------- | --------------- |\n| https://example.com | <https://y.com> |\n",
    ],
    ["two links in one paragraph", "https://a.com and [https://b.com](https://b.com)\n"],
    ["linked image", "[![Arch](https://example.com/i.png)](https://example.com/edit)\n"],
  ])("%s survives unchanged", async (_name, md) => {
    expect(await roundTrip(md)).toBe(md);
  });

  /** What a reader sees: each link's URL and text, the text, and the emphasis. */
  async function shown(markdown: string) {
    const ed = await load(markdown);
    const pm = ed.root.querySelector(".ProseMirror")!;
    const links = [...pm.querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.textContent]);
    // Per non-space character: which of emphasis, strong and strikethrough
    // it is in. (Spaces are skipped: emphasis around a link is written
    // `*a* *https://…*`, which shows the same.)
    let em = "";
    const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const tag = ["EM", "STRONG", "DEL"].map((n) => (t!.parentElement!.closest(n) ? n[0] : "-")).join("");
      em += `${tag} `.repeat(t.textContent!.replace(/\s/g, "").length);
    }
    const out = { links, text: pm.textContent, em };
    await ed.destroy();
    return out;
  }

  // The text after a literal often starts with a mark the serializer escapes;
  // a `\` right after a URL literal would join its URL.
  it.each([
    ["_ after a literal", "a https://a.com/a_b_ c\n", "https://a.com/a_b"],
    ["* after a literal", "x https://a.com/*x* y\n", "https://a.com/*x"],
    ["~ after a www literal", "a www.a.com/x~ c\n", "http://www.a.com/x"],
    ["_ ending the line", "Ends https://a.com/x_\n", "https://a.com/x"],
    ["escaped * after an email literal", "Mail m@a.com\\* now\n", "mailto:m@a.com"],
  ])("a literal before an escaped %s stays bare", async (_name, md, url) => {
    const out = await roundTrip(md);
    expect(out).toBe(md);
    const before = await shown(md);
    expect(before.links.map(([href]) => href)).toEqual([url]);
    expect(await shown(out)).toEqual(before);
  });

  it.each([
    // These URLs end in a backslash (a literal keeps it in its URL).
    "*a https://a.com/x\\* b*\n",
    "**a https://a.com/x\\* b**\n",
    "_a https://a.com/x\\_ b_\n",
    "a https://a.com/x\\ b\n",
    "(https://a.com/x\\)\n",
    "a https://a.com/x\\_c\n",
    "a https://a.com/x_\\_ c\n",
  ])("a literal before an escape keeps its meaning in %j", async (md) => {
    const before = await shown(md);
    const out = await roundTrip(md);
    expect(await shown(out)).toEqual(before);
    expect(await roundTrip(out)).toBe(out);
  });

  it.each([
    ["*a https://a.com/x b*\n", "emphasis"],
    ["**a https://a.com/x b**\n", "strong"],
    ["~~a https://a.com/x b~~\n", "strike_through"],
  ])("a mark typed after a literal in %j can't close the emphasis", async (md, mark) => {
    for (const ch of ["*", "_", "~"]) {
      const { ed, view } = await withView(md);
      const { schema } = view.state;
      const pos = after(view, "https://a.com/x");
      view.dispatch(view.state.tr.insert(pos, schema.text(ch, [schema.marks[mark]!.create()])));
      const out = normalizeTrailingNewlines(ed.markdown());
      await ed.destroy();
      const back = await shown(out);
      expect(back.links).toEqual([["https://a.com/x", "https://a.com/x"]]);
      expect(back.text).toBe(`a https://a.com/x${ch} b`);
      const tag = { emphasis: "E--", strong: "-S-", strike_through: "--D" }[mark]!;
      expect(back.em).toBe(`${tag} `.repeat(back.text!.replace(/\s/g, "").length));
    }
  });

  async function withView(markdown: string) {
    const ed = await load(markdown);
    const { editorViewCtx } = await import("@milkdown/kit/core");
    const view = ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
    return { ed, view };
  }

  /** Position just after the first occurrence of `text` in the document. */
  function after(view: { state: { doc: { descendants: (f: (n: { isText: boolean; text?: string }, pos: number) => boolean | void) => void } } }, text: string): number {
    let at = -1;
    view.state.doc.descendants((n, pos) => {
      if (at >= 0) return false;
      if (n.isText && n.text?.includes(text)) at = pos + n.text.indexOf(text) + text.length;
      return undefined;
    });
    if (at < 0) throw new Error(`no ${text}`);
    return at;
  }

  it("an unrelated edit keeps every link's form", async () => {
    const md = `First paragraph.\n\n${lucid}\n\nSee https://a.com and [https://b.com](https://b.com) and <https://c.com>.\n`;
    const { ed, view } = await withView(md);
    view.dispatch(view.state.tr.insertText(" More", after(view, "First paragraph.")));
    const out = normalizeTrailingNewlines(ed.markdown());
    await ed.destroy();
    expect(out).toBe(md.replace("First paragraph.", "First paragraph. More"));
  });

  it("a literal with text typed right after it falls back to <url>", async () => {
    const { ed, view } = await withView("Go https://example.com now\n");
    const { schema } = view.state;
    const pos = after(view, "https://example.com");
    view.dispatch(view.state.tr.insert(pos, schema.text("x")));
    const out = normalizeTrailingNewlines(ed.markdown());
    await ed.destroy();
    expect(out).toBe("Go <https://example.com>x now\n");
  });

  it("a new link whose text is its url keeps today's <url> form", async () => {
    const { ed, view } = await withView("Start\n");
    const { schema } = view.state;
    const link = schema.marks.link!.create({ href: "https://new.com" });
    view.dispatch(view.state.tr.insert(after(view, "Start"), [schema.text(" "), schema.text("https://new.com", [link])]));
    const out = normalizeTrailingNewlines(ed.markdown());
    await ed.destroy();
    expect(out).toBe("Start <https://new.com>\n");
  });

  it("a literal whose text was edited is written as an inline link", async () => {
    const { ed, view } = await withView("Go https://example.com now\n");
    const pos = after(view, "https://example");
    view.dispatch(view.state.tr.insertText("-x", pos));
    const out = normalizeTrailingNewlines(ed.markdown());
    await ed.destroy();
    expect(out).toBe("Go [https://example-x.com](https://example.com) now\n");
  });
});

describe("link form in the DOM", () => {
  it("is a data attribute, not an <a form>", async () => {
    const ed = await load("See https://example.com now\n");
    const a = ed.root.querySelector(".ProseMirror a")!;
    expect(a.getAttribute("data-ken-form")).toBe("literal");
    expect(a.hasAttribute("form")).toBe(false);
    expect(a.getAttribute("href")).toBe("https://example.com");
    await ed.destroy();
  });
});
