// What's New: decides when to announce an update and renders the release notes
// from CHANGELOG.md (Keep a Changelog format). Pure logic with no `vscode`
// import, so vitest covers it and harness/screenshot-whats-new.mjs can render
// the page outside VS Code. The panel itself lives in whatsNewPanel.ts.

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

/** `1.2.3`, `v1.2.3` or `1.2.3-beta.1` (the pre-release tag is ignored). */
export function parseVersion(text: string): Version | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(text.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : undefined;
}

/** Negative, zero or positive, like a sort comparator. Unparsable versions sort first. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
}

/**
 * Announce an update only when the major or minor version went up. No
 * previous version means a first install (or an update from a release that
 * did not record its version yet): nothing to announce.
 */
export function shouldShowWhatsNew(previous: string | undefined, current: string): boolean {
  if (previous === undefined) return false;
  const p = parseVersion(previous);
  const c = parseVersion(current);
  if (!p || !c) return false;
  return c.major > p.major || (c.major === p.major && c.minor > p.minor);
}

export interface ChangelogSection {
  version: string;
  date?: string;
  /** The section's Markdown, without its `## [x.y.z]` heading. */
  body: string;
}

/** The released version sections of a Keep a Changelog file, newest first as written. */
export function parseChangelog(text: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let current: { version?: string; date?: string; lines: string[] } | undefined;
  const flush = () => {
    if (current?.version) sections.push({ version: current.version, date: current.date, body: current.lines.join("\n").trim() });
  };
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+\[?([^\]\s]+)\]?(?:\s+-\s+(.+?))?\s*$/.exec(line);
    if (heading) {
      flush();
      const version = parseVersion(heading[1]) ? heading[1].replace(/^v/, "") : undefined;
      current = { version, date: heading[2], lines: [] };
      continue;
    }
    // Link reference definitions ([0.4.0]: https://…) are not notes.
    if (current && !/^\[[^\]]+\]:\s*\S+/.test(line)) current.lines.push(line);
  }
  flush();
  return sections;
}

/**
 * The sections to show: versions after `previous`, up to `current`. Without a
 * previous version (the command run by hand), the current major.minor line.
 */
export function sectionsFor(sections: ChangelogSection[], previous: string | undefined, current: string): ChangelogSection[] {
  const c = parseVersion(current);
  return sections.filter((s) => {
    if (compareVersions(s.version, current) > 0) return false;
    if (previous !== undefined) return compareVersions(s.version, previous) > 0;
    const v = parseVersion(s.version)!;
    return !!c && v.major === c.major && v.minor === c.minor;
  });
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** Escaped HTML for one line of Markdown: code spans, bold, italic, links and `<kbd>`. */
export function renderInline(markdown: string): string {
  // Code spans first (any run of backticks, closed by a run of the same
  // length), parked as placeholders so nothing inside them is formatted.
  const codes: string[] = [];
  let text = markdown.replace(/\0/g, "").replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks, code: string) => {
    codes.push(`<code>${escapeHtml(code.trim())}</code>`);
    return `\0${codes.length - 1}\0`;
  });
  text = escapeHtml(text)
    .replace(/&lt;(\/?)kbd&gt;/g, "<$1kbd>")
    .replace(/\*\*(?=\S)(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*(?=\S)([^*]+?)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => {
      // `url` is already escaped, so it is safe inside the quoted attribute.
      return SAFE_URL.test(url) ? `<a href="${url}">${label}</a>` : label;
    });
  return text.replace(/\0(\d+)\0/g, (_, i: string) => codes[Number(i)]);
}

/** Minimal block Markdown for release notes: headings, bullet lists, paragraphs. */
export function renderMarkdown(markdown: string): string {
  const out: string[] = [];
  let items: string[] | undefined;
  let paragraph: string[] | undefined;
  const closeParagraph = () => {
    if (paragraph) out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph = undefined;
  };
  const closeList = () => {
    if (items) out.push("<ul>", ...items.map((item) => `<li>${renderInline(item)}</li>`), "</ul>");
    items = undefined;
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^(#{3,6})\s+(.*)$/.exec(line);
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (!line) {
      closeParagraph();
      closeList();
    } else if (heading) {
      closeParagraph();
      closeList();
      const level = heading[1].length;
      // Keep a Changelog categories (Added, Fixed…) get a coloured marker.
      const kind = /^[a-z]+$/i.test(heading[2]) ? ` data-kind="${heading[2].toLowerCase()}"` : "";
      out.push(`<h${level}${kind}>${renderInline(heading[2])}</h${level}>`);
    } else if (bullet) {
      closeParagraph();
      (items ??= []).push(bullet[1]);
    } else if (items) {
      items[items.length - 1] += " " + line; // continuation of the last item
    } else {
      (paragraph ??= []).push(line);
    }
  }
  closeParagraph();
  closeList();
  return out.join("\n");
}

export interface WhatsNewPage {
  version: string;
  previous?: string;
  sections: ChangelogSection[];
  /** CSP nonce for the page's one style and one script. */
  nonce: string;
}

/**
 * The whole What's New page. Colours and fonts come only from `--vscode-*`
 * variables, so it follows the theme. The buttons post `{ type: "changelog" }`
 * and `{ type: "close" }`; links post `{ type: "open", href }`.
 */
export function whatsNewHtml({ version, previous, sections, nonce }: WhatsNewPage): string {
  const v = escapeHtml(version);
  const subtitle = previous
    ? `Updated from ${escapeHtml(previous)}. Here is what changed.`
    : "Here is what changed in this release.";
  const notes = sections.length
    ? sections
        .map(
          (s) => `<section>
<h2>${escapeHtml(s.version)}${s.date ? ` <span class="date">${escapeHtml(s.date)}</span>` : ""}</h2>
${renderMarkdown(s.body)}
</section>`,
        )
        .join("\n")
    : `<p class="empty">No release notes for this version. See the full changelog.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>What's New in Ken Markdown Editor ${v}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
<header>
<p class="eyebrow">Ken Markdown Editor</p>
<h1>What’s New in ${v}</h1>
<p class="subtitle">${subtitle}</p>
</header>
${notes}
<footer>
<button id="changelog" class="primary">View full changelog</button>
<button id="close" class="secondary">Close</button>
</footer>
</main>
<script nonce="${nonce}">
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : { postMessage() {} };
document.getElementById("changelog").addEventListener("click", () => vscode.postMessage({ type: "changelog" }));
document.getElementById("close").addEventListener("click", () => vscode.postMessage({ type: "close" }));
document.addEventListener("click", (e) => {
  const a = e.target instanceof Element && e.target.closest("a[href]");
  if (!a) return;
  e.preventDefault();
  vscode.postMessage({ type: "open", href: a.getAttribute("href") });
});
</script>
</body>
</html>`;
}

const STYLE = `
:root { color-scheme: light dark; }
body {
  margin: 0;
  padding: 0 24px;
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-font-family);
  font-size: 14px;
  line-height: 1.6;
}
main { max-width: 680px; margin: 0 auto; padding: 40px 0 48px; }
header { padding-bottom: 20px; margin-bottom: 8px; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
.eyebrow {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--vscode-descriptionForeground);
}
h1 { margin: 0; font-size: 24px; font-weight: 600; line-height: 1.3; }
.subtitle { margin: 6px 0 0; color: var(--vscode-descriptionForeground); }
section { padding: 20px 0 4px; }
section + section { border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
h2 { margin: 0 0 4px; font-size: 17px; font-weight: 600; }
h2 .date { margin-left: 6px; font-size: 13px; font-weight: 400; color: var(--vscode-descriptionForeground); }
h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 18px 0 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--vscode-descriptionForeground);
}
h3::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--vscode-charts-blue);
}
h3[data-kind="added"]::before { background: var(--vscode-charts-green); }
h3[data-kind="fixed"]::before { background: var(--vscode-charts-orange); }
h3[data-kind="removed"]::before, h3[data-kind="security"]::before { background: var(--vscode-charts-red); }
h3[data-kind="deprecated"]::before { background: var(--vscode-charts-yellow); }
ul { margin: 0; padding-left: 20px; }
li { margin: 6px 0; }
li::marker { color: var(--vscode-descriptionForeground); }
p { margin: 8px 0; }
strong { font-weight: 600; }
code {
  font-family: var(--vscode-editor-font-family);
  font-size: 0.92em;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--vscode-textCodeBlock-background);
}
kbd {
  font-family: var(--vscode-font-family);
  font-size: 0.85em;
  padding: 1px 5px;
  border-radius: 3px;
  border: 1px solid var(--vscode-keybindingLabel-border);
  border-bottom-color: var(--vscode-keybindingLabel-bottomBorder);
  background: var(--vscode-keybindingLabel-background);
  color: var(--vscode-keybindingLabel-foreground);
}
a { color: var(--vscode-textLink-foreground); text-decoration: none; }
a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
.empty { color: var(--vscode-descriptionForeground); }
footer { display: flex; gap: 8px; margin-top: 28px; }
button {
  font-family: var(--vscode-font-family);
  font-size: 13px;
  line-height: 18px;
  padding: 5px 14px;
  border-radius: 2px;
  border: 1px solid var(--vscode-button-border, transparent);
  cursor: pointer;
}
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
`;
