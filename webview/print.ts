/**
 * Print: a standalone HTML page of the document exactly as the editor shows
 * it (same theme, fonts, rendered diagrams and math), which the host opens in
 * the default browser, where it brings up the print dialog.
 *
 * The page must work outside the webview, so everything it needs is put
 * inside it: the stylesheets' rules, the fonts and images as data URLs, the
 * theme's CSS variables. The editor's own controls (hover buttons, handles,
 * the toolbar, placeholders) and the Properties panel are left out. Diagrams
 * print as diagrams: their source is dropped from the page, and diagrams still
 * rendering are waited for. Nested CSS is written out flat, so the page reads
 * the same in any browser.
 */

import { AUTO_PRINT_SCRIPT } from "../src/printScript";

/** Editor chrome that is not part of the document. */
const CHROME = [
  "button",
  "input[type=file]",
  ".ken-table-width-toggle",
  ".cell-handle",
  ".line-handle",
  ".milkdown-table-block .handle",
  ".operation",
  ".image-resize-handle",
  ".tools",
  ".ken-frontmatter",
  ".ken-frontmatter-add",
  ".ProseMirror-gapcursor",
  ".ProseMirror-separator",
  ".ProseMirror-trailingBreak",
  ".ken-presence",
  "[data-print='skip']",
].join(", ");

async function dataUrl(url: string, cache: Map<string, Promise<string>>): Promise<string> {
  if (url.startsWith("data:")) return url;
  let hit = cache.get(url);
  if (!hit) {
    hit = (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return url;
        const blob = await res.blob();
        return await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => resolve(url);
          reader.readAsDataURL(blob);
        });
      } catch {
        return url;
      }
    })();
    cache.set(url, hit);
  }
  return hit;
}

/** `css` with every `url(...)` (resolved against `base`) inlined; fonts other than woff2 dropped. */
async function inlineUrls(css: string, base: string, cache: Map<string, Promise<string>>): Promise<string> {
  // A font with a woff2 source needs no other: drop the rest so the page stays small.
  css = css.replace(/,\s*url\([^)]*\.(?:woff|ttf|eot|otf)[^)]*\)\s*format\([^)]*\)/g, "");
  const urls = new Set<string>();
  css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (_m, _q, u: string) => {
    if (!u.startsWith("data:") && !u.startsWith("#")) urls.add(u);
    return "";
  });
  const resolved = new Map<string, string>();
  await Promise.all(
    [...urls].map(async (u) => {
      let abs = u;
      try {
        abs = new URL(u, base).toString();
      } catch {
        // Leave it.
      }
      resolved.set(u, await dataUrl(abs, cache));
    }),
  );
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, _q, u: string) => (resolved.has(u) ? `url("${resolved.get(u)}")` : m));
}

/** `selector` (which may use `&`) nested in `parent`, as one flat selector. */
function nestSelector(parent: string, selector: string): string {
  if (!parent) return selector;
  return selector
    .split(/,(?![^(]*\))/)
    .map((part) => {
      const p = part.trim();
      return p.includes("&") ? p.replace(/&/g, `:is(${parent})`) : `:is(${parent}) ${p}`;
    })
    .join(", ");
}

/**
 * A rule as plain, un-nested CSS. Crepe's theme nests its rules (`.milkdown {
 * .hidden { … } }`); written out that way, browsers without CSS nesting would
 * drop them — such as the rule that hides a diagram's code.
 */
export function flatRule(rule: CSSRule, parent = ""): string {
  const style = rule as CSSStyleRule;
  const children = (rule as CSSGroupingRule).cssRules;
  if (typeof style.selectorText === "string") {
    const selector = nestSelector(parent, style.selectorText);
    const own = style.style?.cssText ? `${selector} { ${style.style.cssText} }` : "";
    const nested = children ? Array.from(children, (c) => flatRule(c, selector)).join("\n") : "";
    return [own, nested].filter(Boolean).join("\n");
  }
  if (children && "conditionText" in rule) {
    // @media / @supports / @container: keep the wrapper, flatten inside.
    const head = rule.cssText.slice(0, rule.cssText.indexOf("{")).trim();
    return `${head} {\n${Array.from(children, (c) => flatRule(c, parent)).join("\n")}\n}`;
  }
  if ((rule as unknown as { style?: CSSStyleDeclaration }).style && parent) {
    // Bare declarations nested in a rule (CSSNestedDeclarations).
    return `${parent} { ${(rule as unknown as { style: CSSStyleDeclaration }).style.cssText} }`;
  }
  return rule.cssText;
}

/** Diagrams still rendering (mermaid renders asynchronously): wait for them, a while. */
async function diagramsReady(content: HTMLElement, timeout = 4000): Promise<void> {
  const pending = () =>
    Array.from(content.querySelectorAll<HTMLElement>(".milkdown-code-block")).some((block) => {
      const lang = block.querySelector(".language-button")?.textContent?.trim().toLowerCase();
      return lang === "mermaid" && !block.querySelector(".preview svg, .preview img, .preview .mermaid-error");
    });
  const end = Date.now() + timeout;
  while (pending() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
}

async function collectCss(doc: Document, cache: Map<string, Promise<string>>): Promise<string> {
  const parts: string[] = [];
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    const text = Array.from(rules, (r) => flatRule(r)).join("\n");
    parts.push(await inlineUrls(text, sheet.href ?? doc.baseURI, cache));
  }
  return parts.join("\n");
}

const PRINT_CSS = `
html, body { height: auto !important; overflow: visible !important; display: block !important; }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.editor-scroll { overflow: visible !important; height: auto !important; }
.measure { padding-bottom: 24px !important; }
@page { margin: 14mm; }
@media print {
  .measure { max-width: none !important; padding: 0 !important; }
  pre, table, img, figure, blockquote, .milkdown-image-block, .mermaid-preview { break-inside: avoid; }
  h1, h2, h3, h4, h5, h6 { break-after: avoid; }
}
`;

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A standalone page of `content` (the editor's `.measure` element) as shown now. */
export async function printablePage(content: HTMLElement, title: string, doc: Document = document, autoPrint = true): Promise<string> {
  const cache = new Map<string, Promise<string>>();
  await diagramsReady(content);
  const clone = content.cloneNode(true) as HTMLElement;
  // A rendered diagram prints as itself, never as its source.
  for (const block of Array.from(clone.querySelectorAll(".milkdown-code-block"))) {
    if (block.querySelector(".preview svg, .preview img")) block.querySelector(".codemirror-host")?.remove();
  }
  for (const el of Array.from(clone.querySelectorAll(CHROME))) el.remove();
  for (const el of Array.from(clone.querySelectorAll("[contenteditable]"))) el.removeAttribute("contenteditable");
  for (const el of Array.from(clone.querySelectorAll(".ProseMirror-selectednode, .selectedCell"))) {
    el.classList.remove("ProseMirror-selectednode", "selectedCell");
  }
  // Images: the webview's resource URLs mean nothing outside it.
  const images = Array.from(clone.querySelectorAll<HTMLImageElement>("img"));
  await Promise.all(
    images.map(async (img) => {
      const src = img.getAttribute("src");
      if (!src) return;
      img.removeAttribute("srcset");
      img.removeAttribute("loading");
      try {
        img.setAttribute("src", await dataUrl(new URL(src, doc.baseURI).toString(), cache));
      } catch {
        // Leave the original.
      }
    }),
  );
  // Live embeds (Lucid, draw.io editor) can't be printed from a file.
  for (const frame of Array.from(clone.querySelectorAll("iframe"))) frame.remove();
  const css = await collectCss(doc, cache);
  // The page's own colour reaches the paper's edges too (the margins outside
  // the content are painted by @page, not by the document).
  const paper = doc.defaultView?.getComputedStyle(doc.body).backgroundColor ?? "";
  const pageRule = paper && !/rgba\(0, 0, 0, 0\)|transparent/.test(paper) ? `@page { background: ${paper}; }` : "";
  const rootStyle = doc.documentElement.getAttribute("style") ?? "";
  const bodyClass = doc.body.className.replace(/\bready\b/, "").trim();
  return `<!doctype html>
<html lang="en" style="${escapeHtml(rootStyle)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${css.replace(/<\/style/gi, "<\\/style")}</style>
<style>${PRINT_CSS}${pageRule}</style>
</head>
<body class="${escapeHtml(bodyClass)} ready ken-print">
<div class="editor-scroll"><div class="${escapeHtml(content.className)}">${clone.innerHTML}</div></div>
${autoPrint ? AUTO_PRINT_SCRIPT : ""}
</body>
</html>`;
}
