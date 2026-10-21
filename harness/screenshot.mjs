// Visual check: loads the real webview bundle in Chromium with a VS Code theme
// captured from a real VS Code (see the theme test in test/integration), and
// screenshots it. Usage:
//   node harness/screenshot.mjs <theme.json> <markdown file> <out.png> [width] [fontSize]
import { chromium } from "playwright";
import { readFileSync } from "fs";
import { createServer } from "http";
import { extname, join, resolve } from "path";

const [themeFile, mdFile, out, width = "1100", fontSize = "16"] = process.argv.slice(2);
const theme = JSON.parse(readFileSync(themeFile, "utf8"));
const markdown = readFileSync(mdFile, "utf8");
const root = resolve(".");
const types = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png" };

const html = `<!doctype html><html style='${theme.style.replace(/'/g, "&#39;")}'><head><meta charset="utf-8">
<link rel="stylesheet" href="/dist/webview/main.css"></head>
<body class="${theme.bodyClass.replace(/\bready\b/, "")}">
<div class="editor-scroll" id="scroll"><div class="measure" id="editor"></div></div>
<script>
  window.acquireVsCodeApi = () => ({ postMessage(m) {
    window.__sent = (window.__sent || []).concat([m]);
    if (m.type === "ready") setTimeout(() => window.postMessage({ type: "init", text: ${JSON.stringify(markdown)}, docPath: "doc.md",
      config: { fontSize: ${Number(fontSize)}, bodyFontFamily: "", headingFontFamily: "", codeFontFamily: "", lineHeight: 1.85, maxWidth: 720 } }, "*"));
    if (m.type === "resolve") setTimeout(() => window.postMessage({ type: "resolved", id: m.id, url: "/test/fixtures/" + m.path }, "*"));
  }});
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
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(width), height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`http://localhost:${port}/`);
await page.waitForSelector("body.ready .milkdown .ProseMirror");
await page.waitForTimeout(1500);
await page.screenshot({ path: out, fullPage: true });
const height = await page.evaluate(() => document.getElementById("scroll").scrollHeight);
await page.setViewportSize({ width: Number(width), height: Math.min(height + 40, 6000) });
await page.screenshot({ path: out, fullPage: false });
console.log(JSON.stringify({ out, errors }));
await browser.close();
server.close();
