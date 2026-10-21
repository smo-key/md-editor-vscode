// Loads the real webview bundle (dist/webview) in Chromium with a VS Code
// theme captured from a real VS Code, standing in for the extension host.
import { chromium } from "playwright";
import { readFileSync } from "fs";
import { createServer } from "http";
import { extname, join, resolve } from "path";

const types = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png" };

export async function openHarness({ themeFile, markdown, width = 1100, height = 900, fontSize = 16 }) {
  const theme = JSON.parse(readFileSync(themeFile, "utf8"));
  const root = resolve(".");
  const html = `<!doctype html><html style='${theme.style.replace(/'/g, "&#39;")}'><head><meta charset="utf-8">
<link rel="stylesheet" href="/dist/webview/main.css"></head>
<body class="${theme.bodyClass.replace(/\bready\b/, "")}">
<div class="editor-scroll" id="scroll"><div class="measure" id="editor"></div></div>
<div class="ken-toolbar-host" id="toolbar"></div>
<script>
  window.__sent = [];
  window.acquireVsCodeApi = () => ({ postMessage(m) {
    window.__sent.push(m);
    if (m.type === "ready") setTimeout(() => window.postMessage({ type: "init", text: ${JSON.stringify(markdown)}, docPath: "doc.md",
      config: { fontSize: ${Number(fontSize)}, bodyFontFamily: "", headingFontFamily: "", codeFontFamily: "", lineHeight: 1.85, maxWidth: 720, toolbar: true } }, "*"));
    // Stand-in for the host: "saved" files live in memory as blob URLs,
    // deduped like the host does (name-1.png).
    if (m.type === "saveAttachment") {
      window.__saved = window.__saved || {};
      const dot = m.name.lastIndexOf(".");
      const stem = dot > 0 ? m.name.slice(0, dot) : m.name, ext = dot > 0 ? m.name.slice(dot) : "";
      const dir = m.image ? "_Images/" : "";
      let name = dir + m.name;
      for (let n = 1; window.__saved[name]; n++) name = dir + stem + "-" + n + ext;
      window.__saved[name] = URL.createObjectURL(new Blob([m.data]));
      setTimeout(() => window.postMessage({ type: "attachmentSaved", id: m.id, path: name }, "*"));
    }
    if (m.type === "resolve") setTimeout(() => window.postMessage({ type: "resolved", id: m.id,
      url: (window.__saved && window.__saved[m.path]) || "/test/fixtures/" + m.path }, "*"));
  }});
  window.__lastText = () => { const e = window.__sent.filter((m) => m.type === "edit").pop(); return e ? e.text : null; };
</script>
<script type="module" src="/dist/webview/main.js"></script></body></html>`;
  const server = createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    if (url === "/") return res.end(html);
    try {
      const body = readFileSync(join(root, url));
      res.writeHead(200, { "content-type": types[extname(url)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  }).listen(0);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${server.address().port}/`);
  await page.waitForSelector("body.ready .milkdown .ProseMirror");
  return {
    page,
    errors,
    async close() {
      await browser.close();
      server.close();
    },
  };
}
