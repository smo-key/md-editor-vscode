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

  it("embeds SVG images and Mermaid diagrams as pictures, with a PNG for older readers", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg>';
    const bytes = await markdownToDocx("![logo](logo.svg)\n\n```mermaid\ngraph TD\nA-->B\n```\n\n```mermaid\nbroken\n```\n", template, {
      loadImage: async (src) => (src === "logo.svg" ? { svg, width: 40, height: 20 } : null),
      diagram: (i) => (i === 0 ? { svg, data: png, ext: "png", width: 200, height: 100 } : null),
    });
    const zip = await JSZip.loadAsync(bytes);
    const doc = (await zip.file("word/document.xml")!.async("string"))!;
    const types = (await zip.file("[Content_Types].xml")!.async("string"))!;
    expect(doc.match(/<asvg:svgBlip /g)).toHaveLength(2);
    expect(doc).toContain('<wp:extent cx="381000" cy="190500"/>');
    expect(doc).toContain('<wp:extent cx="1905000" cy="952500"/>');
    expect(doc).toContain('<w:pStyle w:val="CodeBlock"/></w:pPr><w:r><w:t xml:space="preserve">broken</w:t>');
    expect(doc).not.toContain("graph TD");
    expect(Object.keys(zip.files).filter((f) => f.startsWith("word/media/") && !f.endsWith("/")).sort()).toEqual([
      "word/media/ken-image-1.png",
      "word/media/ken-image-2.svg",
      "word/media/ken-image-3.png",
      "word/media/ken-image-4.svg",
    ]);
    expect(types).toContain('Extension="svg" ContentType="image/svg+xml"');
  });

  it("writes math as Word equations", async () => {
    const { doc } = await convert("Inline $x^2$ here.\n\n$$\n\\frac{a}{b} + \\sum_{i=1}^n i\n$$\n\n```latex\n\\sqrt{2}\n```\n");
    expect(doc).toContain('xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"');
    expect(doc).toMatch(/<m:oMath><m:sSup><m:e><m:r><m:t xml:space="preserve">x<\/m:t><\/m:r><\/m:e><m:sup><m:r><m:t xml:space="preserve">2<\/m:t>/);
    expect(doc).toContain("<m:oMathPara><m:oMath><m:f><m:num>");
    expect(doc).toContain('<m:nary><m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="undOvr"/></m:naryPr>');
    expect(doc).toContain('<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr>');
    expect(doc).not.toContain("CodeBlock");
  });

  it("superscript, subscript, and tables without a header or with a total row", async () => {
    const { doc } = await convert(
      "H<sub>2</sub>O and x<sup>2</sup>\n\n<!-- ken:table noheader -->\n|   |   |\n| - | - |\n| a | b |\n\n<!-- ken:table total -->\n| Q | $ |\n| - | - |\n| x | 1 |\n| Total | 1 |\n",
    );
    expect(doc).toContain('<w:vertAlign w:val="subscript"/></w:rPr><w:t xml:space="preserve">2</w:t>');
    expect(doc).toContain('<w:vertAlign w:val="superscript"/></w:rPr><w:t xml:space="preserve">2</w:t>');
    const tables = doc.split("<w:tbl>").slice(1);
    expect(tables[0]).toContain('w:firstRow="0"');
    expect(tables[0]).not.toContain("<w:tblHeader/>");
    expect(tables[0]!.match(/<w:tr>/g)).toHaveLength(1);
    expect(tables[1]).toContain('<w:top w:val="double"');
  });
});

