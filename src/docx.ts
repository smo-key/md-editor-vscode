/**
 * Markdown → DOCX, styled by the Ken Markdown Word template
 * (media/export-template.docx): its styles (Normal, Heading 1–6, Quote, Code
 * Block, Inline Code, Hyperlink, List Bullet/Number, Alert *, Ken Table) give
 * the document its look, and its page setup, fonts (embedded) and numbering
 * come along. Only the body is replaced.
 *
 * Pure (no `vscode`): images are read through a callback. GitHub-flavoured
 * Markdown is parsed with mdast; what Word has no equivalent for degrades to
 * text (Mermaid and math as code, raw HTML as its text).
 */
import JSZip from "jszip";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { math } from "micromark-extension-math";

import { headingSlugs } from "./slug";

export interface ImageData {
  /** PNG, JPEG or GIF bytes; may be absent for an SVG (a blank stand-in is used for old readers). */
  data?: Uint8Array;
  /** png, jpeg or gif. */
  ext?: "png" | "jpeg" | "gif";
  /** The SVG itself, which Word (2016 and later) shows in place of `data`. */
  svg?: string;
  /** Size in CSS pixels, when `data` can't tell it (an SVG). */
  width?: number;
  height?: number;
}

export interface DocxOptions {
  title?: string;
  /** The bytes of an image the document references (`src` as written), or null. */
  loadImage?: (src: string) => Promise<ImageData | null>;
  /** The n-th Mermaid diagram (from 0, in document order) as a picture, or null to keep its source. */
  diagram?: (index: number) => ImageData | null;
}

/** A 1×1 transparent PNG: the stand-in an SVG picture needs for readers without SVG. */
const BLANK_PNG = Uint8Array.from(
  atobBytes("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
);

function atobBytes(b64: string): number[] {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const c of b64.replace(/=+$/, "")) {
    buf = (buf << 6) | chars.indexOf(c);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return out;
}

interface MdNode {
  type: string;
  value?: string;
  depth?: number;
  ordered?: boolean | null;
  start?: number | null;
  checked?: boolean | null;
  url?: string;
  alt?: string | null;
  title?: string | null;
  lang?: string | null;
  align?: (string | null)[] | null;
  identifier?: string;
  label?: string;
  children?: MdNode[];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface RunStyle {
  b?: boolean;
  i?: boolean;
  s?: boolean;
  u?: boolean;
  code?: boolean;
  link?: boolean;
}

const EMU_PER_PX = 9525;
const MAX_WIDTH = 6.5 * 914400;
/** At most half the page's text height, as images are at most half the screen in the editor. */
const MAX_HEIGHT = 4.5 * 914400;

/** Pixel size of a PNG, JPEG or GIF. */
export function imageSize(img: ImageData): { w: number; h: number } | null {
  if (img.width && img.height) return { w: img.width, h: img.height };
  const d = img.data;
  if (!d) return null;
  const u16 = (i: number) => (d[i]! << 8) | d[i + 1]!;
  const u32 = (i: number) => ((d[i]! << 24) | (d[i + 1]! << 16) | (d[i + 2]! << 8) | d[i + 3]!) >>> 0;
  if (img.ext === "png" && d.length > 24) return { w: u32(16), h: u32(20) };
  if (img.ext === "gif" && d.length > 10) return { w: d[6]! | (d[7]! << 8), h: d[8]! | (d[9]! << 8) };
  if (img.ext === "jpeg") {
    let i = 2;
    while (i + 9 < d.length) {
      if (d[i] !== 0xff) return null;
      const marker = d[i + 1]!;
      const len = u16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: u16(i + 7), h: u16(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

/** The text of an mdast subtree. */
function textOf(node: MdNode): string {
  if (node.value !== undefined && node.type !== "html") return node.value;
  return (node.children ?? []).map(textOf).join("");
}

const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i;
const KEN_COMMENT = /^<!--\s*ken:/;

class Writer {
  body: string[] = [];
  rels: string[] = [];
  media: { name: string; data: Uint8Array | string; ext: string }[] = [];
  private diagramIndex = 0;
  nums: { abstract: string; id: number; start: number }[] = [];
  private relSeq = 1000;
  private picSeq = 1;
  private slugs: string[];
  private slugIndex = 0;
  private underline = false;

  constructor(
    private readonly loadImage: DocxOptions["loadImage"],
    private readonly diagram: DocxOptions["diagram"],
    private readonly numbering: NumberingInfo,
    headings: string[],
  ) {
    this.slugs = headingSlugs(headings);
  }

  private rel(type: string, target: string, external = false): string {
    const id = `rIdK${++this.relSeq}`;
    this.rels.push(
      `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${esc(target)}"${external ? ' TargetMode="External"' : ""}/>`,
    );
    return id;
  }

  private run(text: string, st: RunStyle): string {
    const props: string[] = [];
    if (st.code) props.push('<w:rStyle w:val="InlineCode"/>');
    else if (st.link) props.push('<w:rStyle w:val="Hyperlink"/>');
    if (st.b) props.push("<w:b/>");
    if (st.i) props.push("<w:i/>");
    if (st.s) props.push("<w:strike/>");
    if (st.u || this.underline) props.push('<w:u w:val="single"/>');
    const rPr = props.length ? `<w:rPr>${props.join("")}</w:rPr>` : "";
    return text
      .split("\n")
      .map((line, i) => `<w:r>${rPr}${i ? "<w:br/>" : ""}<w:t xml:space="preserve">${esc(line)}</w:t></w:r>`)
      .join("");
  }

  async inlines(nodes: MdNode[], st: RunStyle = {}): Promise<string> {
    let out = "";
    for (const n of nodes) out += await this.inline(n, st);
    return out;
  }

  private async inline(n: MdNode, st: RunStyle): Promise<string> {
    switch (n.type) {
      case "text":
        // A line break in a paragraph's source is a space (a hard break is a `break` node).
        return this.run((n.value ?? "").replace(/\s*\n\s*/g, " "), st);
      case "strong":
        return this.inlines(n.children ?? [], { ...st, b: true });
      case "emphasis":
        return this.inlines(n.children ?? [], { ...st, i: true });
      case "delete":
        return this.inlines(n.children ?? [], { ...st, s: true });
      case "inlineCode":
        return this.run(n.value ?? "", { ...st, code: true });
      case "inlineMath":
        return this.run(n.value ?? "", { ...st, code: true });
      case "break":
        return "<w:r><w:br/></w:r>";
      case "link": {
        const url = n.url ?? "";
        const inner = await this.inlines(n.children ?? [], { ...st, link: true });
        if (url.startsWith("#")) return `<w:hyperlink w:anchor="${esc(decodeURIComponent(url.slice(1)))}">${inner}</w:hyperlink>`;
        return `<w:hyperlink r:id="${this.rel("hyperlink", url, true)}">${inner}</w:hyperlink>`;
      }
      case "image":
        return this.image(n, st);
      case "footnoteReference":
        return this.run(`[${n.label ?? n.identifier ?? ""}]`, st);
      case "html": {
        const v = (n.value ?? "").trim();
        if (/^<br\s*\/?>$/i.test(v)) return "<w:r><w:br/></w:r>";
        if (/^<(ins|u)>$/i.test(v)) {
          this.underline = true;
          return "";
        }
        if (/^<\/(ins|u)>$/i.test(v)) {
          this.underline = false;
          return "";
        }
        if (/^<li>$/i.test(v)) return `<w:r><w:br/></w:r>${this.run("•  ", st)}`;
        // Other tags (and comments) are dropped; their text stays.
        if (/^</.test(v)) return "";
        return this.run(decodeEntities(v), st);
      }
      default:
        return n.children ? this.inlines(n.children, st) : this.run(n.value ?? "", st);
    }
  }

  private async image(n: MdNode, st: RunStyle): Promise<string> {
    const src = n.url ?? "";
    const img = this.loadImage ? await this.loadImage(src).catch(() => null) : null;
    const size = img ? imageSize(img) : null;
    if (!img || !size || !size.w || !size.h || (!img.data && !img.svg)) {
      // Not something Word can show: a link to it instead.
      const label = n.alt || src;
      if (!/^https?:/i.test(src)) return this.run(`[${label}]`, st);
      return `<w:hyperlink r:id="${this.rel("hyperlink", src, true)}">${this.run(label, { ...st, link: true })}</w:hyperlink>`;
    }
    return this.picture(img, size, n.alt ?? "");
  }

  /** An inline picture: the PNG/JPEG/GIF, and the SVG over it where there is one. */
  private picture(img: ImageData, size: { w: number; h: number }, altText: string): string {
    const ext = img.data ? (img.ext ?? "png") : "png";
    const name = `ken-image-${this.media.length + 1}.${ext}`;
    this.media.push({ name, data: img.data ?? BLANK_PNG, ext });
    const rid = this.rel("image", `media/${name}`);
    let svgExt = "";
    if (img.svg) {
      const svgName = `ken-image-${this.media.length + 1}.svg`;
      this.media.push({ name: svgName, data: img.svg, ext: "svg" });
      const svgRid = this.rel("image", `media/${svgName}`);
      svgExt = `<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="${svgRid}"/></a:ext></a:extLst>`;
    }
    let cx = size.w * EMU_PER_PX;
    let cy = size.h * EMU_PER_PX;
    const k = Math.min(1, MAX_WIDTH / cx, MAX_HEIGHT / cy);
    cx = Math.round(cx * k);
    cy = Math.round(cy * k);
    const id = this.picSeq++;
    const alt = esc(altText);
    return (
      `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
      `<wp:docPr id="${id}" name="Picture ${id}" descr="${alt}"/>` +
      `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
      `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rid}">${svgExt}</a:blip><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
      `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
    );
  }

  para(style: string | null, content: string, extra = ""): void {
    const pPr = style || extra ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${extra}</w:pPr>` : "";
    this.body.push(`<w:p>${pPr}${content}</w:p>`);
  }

  async blocks(nodes: MdNode[], ctx: BlockContext = {}): Promise<void> {
    for (const n of nodes) await this.block(n, ctx);
  }

  private async block(n: MdNode, ctx: BlockContext): Promise<void> {
    switch (n.type) {
      case "heading": {
        const slug = this.slugs[this.slugIndex++] ?? "";
        const id = this.slugIndex;
        const content = await this.inlines(n.children ?? []);
        const mark = slug ? `<w:bookmarkStart w:id="${id}" w:name="${esc(slug)}"/>${content}<w:bookmarkEnd w:id="${id}"/>` : content;
        this.para(`Heading${Math.min(6, Math.max(1, n.depth ?? 1))}`, mark);
        return;
      }
      case "paragraph": {
        const kids = n.children ?? [];
        const onlyImage = kids.length === 1 && kids[0]!.type === "image";
        this.para(ctx.style ?? null, (ctx.prefix ?? "") + (await this.inlines(kids)), onlyImage && !ctx.style ? '<w:jc w:val="center"/>' : ctx.extra ?? "");
        ctx.prefix = undefined;
        return;
      }
      case "blockquote": {
        const kids = n.children ?? [];
        const first = kids[0];
        const firstText = first?.type === "paragraph" && first.children?.[0]?.type === "text" ? first.children[0] : null;
        const alert = firstText ? ALERT.exec(firstText.value ?? "") : null;
        if (alert && firstText) {
          const kind = alert[1]!.charAt(0) + alert[1]!.slice(1).toLowerCase();
          firstText.value = (firstText.value ?? "").slice(alert[0].length);
          const style = `Alert${kind}`;
          const label = this.run(`${kind}`, { b: true });
          if (first!.children!.length === 1 && !firstText.value) kids.shift();
          if (!kids.length) {
            this.para(style, label);
            return;
          }
          let labelled = false;
          for (const k of kids) {
            if (k.type === "paragraph" && !labelled) {
              this.para(style, label + "<w:r><w:br/></w:r>" + (await this.inlines(k.children ?? [])));
              labelled = true;
            } else await this.block(k, { style });
          }
          return;
        }
        await this.blocks(kids, { style: "Quote" });
        return;
      }
      case "list":
        await this.list(n, ctx.level ?? 0);
        return;
      case "code":
        if ((n.lang ?? "").toLowerCase() === "mermaid") {
          const pic = this.diagram?.(this.diagramIndex++) ?? null;
          const size = pic ? imageSize(pic) : null;
          if (pic && size) {
            this.para(null, this.picture(pic, size, "Diagram"), '<w:jc w:val="center"/>');
            return;
          }
        }
      // falls through
      case "math": {
        const lines = (n.value ?? "").split("\n");
        for (const line of lines) this.para("CodeBlock", this.run(line, {}));
        return;
      }
      case "thematicBreak":
        this.para(null, "", '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D9D9D9"/></w:pBdr>');
        return;
      case "table":
        await this.table(n);
        return;
      case "html": {
        const v = (n.value ?? "").trim();
        if (KEN_COMMENT.test(v) || /^<!--[\s\S]*-->$/.test(v)) return;
        const text = v.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();
        if (text) this.para(ctx.style ?? null, this.run(decodeEntities(text), {}));
        return;
      }
      case "footnoteDefinition":
        ctx = { ...ctx, prefix: this.run(`[${n.label ?? n.identifier}] `, {}) };
        await this.blocks(n.children ?? [], ctx);
        return;
      case "definition":
      case "yaml":
        return;
      default:
        if (n.children) await this.blocks(n.children, ctx);
        else if (n.value) this.para(ctx.style ?? null, this.run(n.value, {}));
    }
  }

  private async list(n: MdNode, level: number): Promise<void> {
    const ordered = !!n.ordered;
    const suffix = level === 0 ? "" : String(Math.min(level + 1, 3));
    const style = (ordered ? "ListNumber" : "ListBullet") + suffix;
    const continueStyle = "ListContinue" + suffix;
    // A numbered list starts its own count (and at its own number).
    let numPr = "";
    if (ordered) {
      const abstract = this.numbering.abstractFor(style);
      if (abstract !== null) {
        const id = this.numbering.next++;
        this.nums.push({ abstract, id, start: n.start ?? 1 });
        numPr = `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${id}"/></w:numPr>`;
      }
    }
    for (const item of n.children ?? []) {
      const kids = item.children ?? [];
      const task = item.checked === true || item.checked === false;
      let first = true;
      for (const k of kids) {
        if (k.type === "paragraph" && first) {
          const box = task ? this.run(item.checked ? "☑  " : "☐  ", {}) : "";
          this.para(task ? continueStyle : style, box + (await this.inlines(k.children ?? [])), task ? "" : numPr);
          first = false;
        } else if (k.type === "list") await this.list(k, level + 1);
        else await this.block(k, { style: continueStyle, level: level + 1 });
      }
      if (first) this.para(task ? continueStyle : style, task ? this.run(item.checked ? "☑" : "☐", {}) : "", task ? "" : numPr);
    }
  }

  private async table(n: MdNode): Promise<void> {
    const rows = n.children ?? [];
    const align = n.align ?? [];
    let xml = '<w:tbl><w:tblPr><w:tblStyle w:val="KenTable"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr><w:tblGrid>';
    const cols = Math.max(0, ...rows.map((r) => r.children?.length ?? 0));
    for (let i = 0; i < cols; i++) xml += "<w:gridCol/>";
    xml += "</w:tblGrid>";
    for (const [ri, row] of rows.entries()) {
      xml += `<w:tr>${ri === 0 ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}`;
      for (let ci = 0; ci < cols; ci++) {
        const cell = row.children?.[ci];
        const jc = align[ci] === "center" ? "center" : align[ci] === "right" ? "right" : null;
        const content = cell ? await this.inlines(cell.children ?? []) : "";
        xml += `<w:tc><w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="288" w:lineRule="auto"/>${jc ? `<w:jc w:val="${jc}"/>` : ""}</w:pPr>${content}</w:p></w:tc>`;
      }
      xml += "</w:tr>";
    }
    xml += "</w:tbl>";
    this.body.push(xml);
    // Word needs a paragraph between two tables, and after the last one.
    this.para(null, "", '<w:spacing w:before="0" w:after="0"/>');
  }
}

interface BlockContext {
  style?: string;
  extra?: string;
  prefix?: string;
  level?: number;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

class NumberingInfo {
  next: number;
  constructor(
    private readonly styles: string,
    private readonly numbering: string,
  ) {
    const ids = [...numbering.matchAll(/<w:num w:numId="(\d+)"/g)].map((m) => Number(m[1]));
    this.next = Math.max(100, ...ids) + 1;
  }

  /** The abstract numbering a list style's own numbering is built on. */
  abstractFor(styleId: string): string | null {
    const style = new RegExp(`<w:style [^>]*w:styleId="${styleId}"[\\s\\S]*?</w:style>`).exec(this.styles)?.[0];
    const numId = style && /<w:numId w:val="(\d+)"/.exec(style)?.[1];
    if (!numId) return null;
    return new RegExp(`<w:num w:numId="${numId}"[^>]*>\\s*<w:abstractNumId w:val="(\\d+)"`).exec(this.numbering)?.[1] ?? null;
  }
}

/** Remove the frontmatter and Ken's own comment block before converting. */
export function exportableMarkdown(text: string): string {
  let body = text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, "");
  body = body.replace(/\n?<!--\s*ken:comments[\s\S]*?-->\s*$/, "\n");
  return body;
}

/** The DOCX of `markdown`, built on `template` (the bytes of a .docx). */
export async function markdownToDocx(markdown: string, template: Uint8Array, options: DocxOptions = {}): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(template);
  const styles = (await zip.file("word/styles.xml")?.async("string")) ?? "";
  let numbering = (await zip.file("word/numbering.xml")?.async("string")) ?? "";
  const tree = fromMarkdown(exportableMarkdown(markdown), {
    extensions: [gfm(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  }) as unknown as MdNode;

  const headings: string[] = [];
  const walk = (n: MdNode) => {
    if (n.type === "heading") headings.push(textOf(n));
    n.children?.forEach(walk);
  };
  walk(tree);

  const writer = new Writer(options.loadImage, options.diagram, new NumberingInfo(styles, numbering), headings);
  await writer.blocks(tree.children ?? []);

  // The template's body is replaced; its page setup (the last sectPr) stays.
  const docXml = (await zip.file("word/document.xml")!.async("string"))!;
  const sect = /<w:sectPr[\s\S]*?<\/w:sectPr>\s*<\/w:body>/.exec(docXml)?.[0].replace(/<\/w:body>$/, "") ?? "";
  const open = docXml.slice(0, docXml.indexOf("<w:body>") + "<w:body>".length);
  const close = docXml.slice(docXml.indexOf("</w:body>"));
  let root = open;
  for (const [prefix, uri] of [
    ["wp", "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"],
    ["r", "http://schemas.openxmlformats.org/officeDocument/2006/relationships"],
  ] as const) {
    if (!root.includes(`xmlns:${prefix}=`)) root = root.replace("<w:document ", `<w:document xmlns:${prefix}="${uri}" `);
  }
  zip.file("word/document.xml", root + writer.body.join("") + sect + close);

  // Relationships: the template's, minus none, plus links and images.
  const relsPath = "word/_rels/document.xml.rels";
  const rels = (await zip.file(relsPath)?.async("string")) ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  zip.file(relsPath, rels.replace("</Relationships>", writer.rels.join("") + "</Relationships>"));
  for (const m of writer.media) zip.file(`word/media/${m.name}`, m.data);

  if (writer.nums.length && numbering) {
    const nums = writer.nums
      .map((n) => `<w:num w:numId="${n.id}"><w:abstractNumId w:val="${n.abstract}"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="${n.start}"/></w:lvlOverride></w:num>`)
      .join("");
    numbering = numbering.replace("</w:numbering>", nums + "</w:numbering>");
    zip.file("word/numbering.xml", numbering);
  }

  let types = (await zip.file("[Content_Types].xml")!.async("string"))!;
  for (const [ext, mime] of [
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
    ["svg", "image/svg+xml"],
  ]) {
    if (writer.media.some((m) => m.ext === ext) && !types.includes(`Extension="${ext}"`)) {
      types = types.replace("</Types>", `<Default Extension="${ext}" ContentType="${mime}"/></Types>`);
    }
  }
  zip.file("[Content_Types].xml", types);

  // The template's own preview picture and title would describe the sample page.
  zip.remove("docProps/thumbnail.jpeg");
  const relsRoot = await zip.file("_rels/.rels")?.async("string");
  if (relsRoot) zip.file("_rels/.rels", relsRoot.replace(/<Relationship [^>]*thumbnail[^>]*\/>/, ""));
  if (types.includes("thumbnail.jpeg")) zip.file("[Content_Types].xml", types.replace(/<Override PartName="\/docProps\/thumbnail.jpeg"[^>]*\/>/, ""));
  const core = await zip.file("docProps/core.xml")?.async("string");
  if (core && options.title) zip.file("docProps/core.xml", core.replace(/<dc:title>[^<]*<\/dc:title>/, `<dc:title>${esc(options.title)}</dc:title>`));

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
