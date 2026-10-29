// Markdown → DOCX on the Ken Markdown Word template (src/docx.ts).
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import { exportableMarkdown, imageSize, markdownToDocx } from "../../src/docx";

const template = new Uint8Array(readFileSync("media/export-template.docx"));
// A 2×3 PNG (header only matters for the size).
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0]);

async function convert(md: string) {
  const bytes = await markdownToDocx(md, template, {
    title: "Doc",
    loadImage: async (src) => (src === "pic.png" ? { data: png, ext: "png" } : null),
  });
  const zip = await JSZip.loadAsync(bytes);
  const read = async (p: string) => (await zip.file(p)?.async("string")) ?? "";
  return { zip, doc: await read("word/document.xml"), rels: await read("word/_rels/document.xml.rels"), numbering: await read("word/numbering.xml"), types: await read("[Content_Types].xml") };
}

describe("DOCX export", () => {
  it("maps Markdown to the template's styles", async () => {
    const { doc } = await convert(
      "# Title\n\nSome **bold**, *it*, ~~gone~~ and `code`.\n\n> A quote\n\n> [!NOTE]\n> Heads up\n\n```js\nconst x = 1;\nlet y;\n```\n\n- a\n  - b\n- [x] done\n\n---\n",
    );
    expect(doc).toContain('<w:pStyle w:val="Heading1"/>');
    expect(doc).toMatch(/<w:bookmarkStart w:id="1" w:name="title"\/>/);
    expect(doc).toContain("<w:b/>");
    expect(doc).toContain("<w:i/>");
    expect(doc).toContain("<w:strike/>");
    expect(doc).toContain('<w:rStyle w:val="InlineCode"/>');
    expect(doc).toContain('<w:pStyle w:val="Quote"/>');
    expect(doc).toMatch(/<w:pStyle w:val="AlertNote"\/><\/w:pPr><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">Note<\/w:t>/);
    expect(doc.match(/<w:pStyle w:val="CodeBlock"\/>/g)).toHaveLength(2);
    expect(doc).toContain('<w:pStyle w:val="ListBullet"/>');
    expect(doc).toContain('<w:pStyle w:val="ListBullet2"/>');
    expect(doc).toContain("☑");
    expect(doc).toContain("<w:sectPr");
    expect(doc).not.toContain("Document title");
  });

  it("underlines <ins> and drops other inline HTML tags", async () => {
    const { doc } = await convert("a <ins>under</ins> <kbd>K</kbd> b\nc\n");
    expect(doc).toContain('<w:u w:val="single"/></w:rPr><w:t xml:space="preserve">under</w:t>');
    expect(doc).not.toContain("&lt;ins&gt;");
    expect(doc).not.toContain("&lt;kbd&gt;");
    expect(doc).toContain("b c");
  });

  it("restarts each numbered list at its own start", async () => {
    const { doc, numbering } = await convert("1. a\n2. b\n\ntext\n\n3. c\n");
    const ids = [...doc.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(2);
    expect(numbering).toContain(`<w:num w:numId="${ids[0]}">`);
    expect(numbering).toMatch(new RegExp(`<w:num w:numId="${ids[2]}"><w:abstractNumId w:val="\\d+"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="3"/>`));
  });

  it("links, tables and images", async () => {
    const { doc, rels, zip, types } = await convert(
      "See [site](https://example.com) and [here](#title).\n\n# Title\n\n| A | B |\n| - | :-: |\n| 1 | 2<br>3 |\n\n![alt](pic.png)\n\n![web](https://x.com/a.svg)\n",
    );
    expect(rels).toMatch(/Target="https:\/\/example.com" TargetMode="External"/);
    expect(doc).toContain('<w:hyperlink w:anchor="title">');
    expect(doc).toContain('<w:tblStyle w:val="KenTable"/>');
    expect(doc).toContain("<w:tblHeader/>");
    expect(doc).toContain('<w:jc w:val="center"/>');
    expect(doc).toContain("<w:drawing>");
    expect(doc).toContain('<wp:extent cx="19050" cy="28575"/>');
    expect(zip.file("word/media/ken-image-1.png")).toBeTruthy();
    expect(types).toContain('Extension="png"');
    expect(rels).toMatch(/Target="https:\/\/x.com\/a.svg" TargetMode="External"/);
  });

  it("leaves out frontmatter and Ken's comments", () => {
    expect(exportableMarkdown("---\ntitle: x\n---\n\nBody\n\n<!-- ken:comments\n{}\n-->\n")).toBe("\nBody\n\n");
  });

  it("reads image sizes", () => {
    expect(imageSize({ data: png, ext: "png" })).toEqual({ w: 2, h: 3 });
  });
});
