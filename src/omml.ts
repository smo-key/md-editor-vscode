/**
 * LaTeX → Office Math (OMML), so equations in a Word export are real,
 * editable Word equations. KaTeX turns the LaTeX into MathML; this maps the
 * MathML KaTeX writes (presentation MathML) onto OMML. Pure.
 */
import katex from "katex";

interface El {
  name: string;
  attrs: Record<string, string>;
  children: (El | string)[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

/** A small parser for the well-formed XML KaTeX writes. */
export function parseXml(xml: string): El {
  const root: El = { name: "#root", attrs: {}, children: [] };
  const stack: El[] = [root];
  const re = /<!--[\s\S]*?-->|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const top = stack[stack.length - 1]!;
    if (m[5] !== undefined) {
      top.children.push(decode(m[5]));
      continue;
    }
    if (!m[2]) continue;
    if (m[1]) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (m[3] ?? "").matchAll(/([\w:.-]+)="([^"]*)"/g)) attrs[a[1]!] = decode(a[2]!);
    const el: El = { name: m[2], attrs, children: [] };
    top.children.push(el);
    if (!m[4]) stack.push(el);
  }
  return root;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const kids = (el: El) => el.children.filter((c): c is El => typeof c !== "string");
const text = (el: El | string): string => (typeof el === "string" ? el : el.children.map(text).join(""));

/** Large operators that take limits and an operand (m:nary). */
const NARY = new Set(["∑", "∏", "∐", "∫", "∬", "∭", "∮", "∯", "∰", "⋃", "⋂", "⋁", "⋀", "⨁", "⨂", "⨀"]);

function run(t: string, style: "p" | "b" | "i" | "bi" | null): string {
  if (!t) return "";
  const rPr = style ? `<m:rPr><m:sty m:val="${style}"/></m:rPr>` : "";
  return `<m:r>${rPr}<m:t xml:space="preserve">${esc(t)}</m:t></m:r>`;
}

const STYLE: Record<string, "p" | "b" | "i" | "bi"> = { normal: "p", bold: "b", italic: "i", "bold-italic": "bi" };

function naryOf(el: El): { chr: string; sub: El | null; sup: El | null; loc: "undOvr" | "subSup" } | null {
  const [base, a, b] = kids(el);
  if (!base || base.name !== "mo" || !NARY.has(text(base).trim())) return null;
  const chr = text(base).trim();
  const integral = /[∫∬∭∮∯∰]/.test(chr);
  switch (el.name) {
    case "munderover":
      return { chr, sub: a ?? null, sup: b ?? null, loc: integral ? "subSup" : "undOvr" };
    case "msubsup":
      return { chr, sub: a ?? null, sup: b ?? null, loc: integral ? "subSup" : "undOvr" };
    case "munder":
    case "msub":
      return { chr, sub: a ?? null, sup: null, loc: integral ? "subSup" : "undOvr" };
    case "mover":
    case "msup":
      return { chr, sub: null, sup: a ?? null, loc: integral ? "subSup" : "undOvr" };
    default:
      return null;
  }
}

/** A sequence of elements (an mrow's children), where a large operator takes what follows as its operand. */
function seq(els: (El | string)[]): string {
  const list = els.filter((c): c is El => typeof c !== "string");
  let out = "";
  for (let i = 0; i < list.length; i++) {
    const el = list[i]!;
    const nary = naryOf(el) ?? (el.name === "mo" && NARY.has(text(el).trim()) ? { chr: text(el).trim(), sub: null, sup: null, loc: "undOvr" as const } : null);
    if (nary) {
      // The operand: the rest of the row up to a relation (=, <, …), or the next element.
      let j = i + 1;
      const operand: El[] = [];
      while (j < list.length && !(list[j]!.name === "mo" && /^[=<>≤≥≠≈≡→⇒]$/.test(text(list[j]!).trim()))) operand.push(list[j++]!);
      i = j - 1;
      const pr =
        `<m:naryPr><m:chr m:val="${esc(nary.chr)}"/><m:limLoc m:val="${nary.loc}"/>` +
        (nary.sub ? "" : '<m:subHide m:val="1"/>') +
        (nary.sup ? "" : '<m:supHide m:val="1"/>') +
        "</m:naryPr>";
      out += `<m:nary>${pr}<m:sub>${nary.sub ? node(nary.sub) : ""}</m:sub><m:sup>${nary.sup ? node(nary.sup) : ""}</m:sup><m:e>${seq(operand)}</m:e></m:nary>`;
      continue;
    }
    out += node(el);
  }
  return out;
}

/** KaTeX's accent marks, as the combining characters Word places over a letter. */
const ACCENTS: Record<string, string> = {
  "^": "\u0302",
  "ˆ": "\u0302",
  "~": "\u0303",
  "˜": "\u0303",
  "¯": "\u0305",
  "‾": "\u0305",
  "→": "\u20d7",
  "˙": "\u0307",
  "¨": "\u0308",
  "ˇ": "\u030c",
  "´": "\u0301",
  "`": "\u0300",
  "˘": "\u0306",
};

const arg = (el: El | undefined) => (el ? node(el) : "");

function node(el: El): string {
  const c = kids(el);
  switch (el.name) {
    case "mi": {
      const t = text(el);
      const v = el.attrs.mathvariant;
      return run(t, v ? (STYLE[v] ?? null) : t.length > 1 ? "p" : null);
    }
    case "mn":
      return run(text(el), el.attrs.mathvariant ? (STYLE[el.attrs.mathvariant] ?? null) : null);
    case "mo":
      return run(text(el).replace(/\u2061/g, ""), "p");
    case "mtext":
    case "ms":
      return run(text(el), "p");
    case "mspace":
      return run(" ", "p");
    case "msup":
      return `<m:sSup><m:e>${arg(c[0])}</m:e><m:sup>${arg(c[1])}</m:sup></m:sSup>`;
    case "msub":
      return `<m:sSub><m:e>${arg(c[0])}</m:e><m:sub>${arg(c[1])}</m:sub></m:sSub>`;
    case "msubsup":
      return `<m:sSubSup><m:e>${arg(c[0])}</m:e><m:sub>${arg(c[1])}</m:sub><m:sup>${arg(c[2])}</m:sup></m:sSubSup>`;
    case "mfrac": {
      const noBar = /^0(\.0+)?(px|em|pt)?$/.test(el.attrs.linethickness ?? "");
      return `<m:f>${noBar ? '<m:fPr><m:type m:val="noBar"/></m:fPr>' : ""}<m:num>${arg(c[0])}</m:num><m:den>${arg(c[1])}</m:den></m:f>`;
    }
    case "msqrt":
      return `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${seq(c)}</m:e></m:rad>`;
    case "mroot":
      return `<m:rad><m:deg>${arg(c[1])}</m:deg><m:e>${arg(c[0])}</m:e></m:rad>`;
    case "mover": {
      if (el.attrs.accent === "true" && c[1]?.name === "mo") {
        const mark = text(c[1]).trim();
        return `<m:acc><m:accPr><m:chr m:val="${esc(ACCENTS[mark] ?? mark)}"/></m:accPr><m:e>${arg(c[0])}</m:e></m:acc>`;
      }
      return `<m:limUpp><m:e>${arg(c[0])}</m:e><m:lim>${arg(c[1])}</m:lim></m:limUpp>`;
    }
    case "munder":
      return `<m:limLow><m:e>${arg(c[0])}</m:e><m:lim>${arg(c[1])}</m:lim></m:limLow>`;
    case "munderover":
      return `<m:limUpp><m:e><m:limLow><m:e>${arg(c[0])}</m:e><m:lim>${arg(c[1])}</m:lim></m:limLow></m:e><m:lim>${arg(c[2])}</m:lim></m:limUpp>`;
    case "mtable": {
      const rows = c.filter((r) => r.name === "mtr" || r.name === "mlabeledtr");
      const cols = Math.max(1, ...rows.map((r) => kids(r).length));
      const mr = rows
        .map((r) => {
          const cells = kids(r).map((cell) => `<m:e>${seq(cell.children)}</m:e>`);
          while (cells.length < cols) cells.push("<m:e/>");
          return `<m:mr>${cells.join("")}</m:mr>`;
        })
        .join("");
      return `<m:m><m:mPr><m:mcs><m:mc><m:mcPr><m:count m:val="${cols}"/><m:mcJc m:val="center"/></m:mcPr></m:mc></m:mcs></m:mPr>${mr}</m:m>`;
    }
    case "annotation":
    case "annotation-xml":
    case "mphantom":
      return "";
    default:
      // math, semantics, mrow, mstyle, mpadded, menclose, merror…
      return seq(el.children);
  }
}

/** The OMML of `tex` (an `m:oMath` element), or null when KaTeX can't read it. */
export function texToOmml(tex: string, display: boolean): string | null {
  let mathml: string;
  try {
    mathml = katex.renderToString(tex, { output: "mathml", displayMode: display, throwOnError: true });
  } catch {
    return null;
  }
  const root = parseXml(mathml);
  const find = (el: El): El | null => (el.name === "math" ? el : kids(el).map(find).find(Boolean) ?? null);
  const math = find(root);
  if (!math) return null;
  return `<m:oMath>${node(math)}</m:oMath>`;
}
