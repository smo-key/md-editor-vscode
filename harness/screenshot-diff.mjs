// Visual check of the diff view (webview/diff.ts) under a captured VS Code
// theme. Usage:
//   node harness/screenshot-diff.mjs <theme.json> <old.md> <new.md> <out.png> [combined|split] [width]
import { chromium } from "playwright";
import { readFileSync } from "fs";
import { createServer } from "http";
import { extname, join, resolve } from "path";

const [themeFile, oldFile, newFile, out, layout = "combined", width = "1300"] = process.argv.slice(2);
const theme = JSON.parse(readFileSync(themeFile, "utf8"));
const types = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".svg": "image/svg+xml" };
const init = {
  type: "diffInit",
  layout,
  base: { old: "", new: "" },
  readOnly: { old: process.env.KEN_OLD_READONLY === "1", new: false },
  shortcuts: {},
  keys: {},
  oldText: readFileSync(oldFile, "utf8"),
  newText: readFileSync(newFile, "utf8"),
  oldLabel: "HEAD (abc1234)",
  newLabel: "Working Tree",
  config: { fontSize: 16, bodyFontFamily: "", headingFontFamily: "", codeFontFamily: "", lineHeight: 1.85, maxWidth: 720, toolbar: "hidden", tabSize: 4 },
};
const html = `<!doctype html><html style='${theme.style.replace(/'/g, "&#39;")}'><head><meta charset="utf-8">
<link rel="stylesheet" href="/dist/webview/diff.css"></head>
<body class="${theme.bodyClass.replace(/\bready\b/, "")}">
<script>
  window.__sent = [];
  window.acquireVsCodeApi = () => ({ postMessage(m) {
    window.__sent.push(m);
    if (m.type === "diffReady") setTimeout(() => window.postMessage(${JSON.stringify(init)}, "*"));
  }});
</script>
<script type="module" src="/dist/webview/diff.js"></script></body></html>`;
const root = resolve(".");
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
const page = await browser.newPage({ viewport: { width: Number(width), height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`http://localhost:${server.address().port}/`);
await page.waitForSelector("body.ready .milkdown .ProseMirror");
await page.waitForTimeout(1200);
const height = await page.evaluate(() => Math.max(...[...document.querySelectorAll(".editor-scroll")].map((s) => s.scrollHeight)));
await page.setViewportSize({ width: Number(width), height: Math.min(height + 120, 5000) });
await page.waitForTimeout(300);
await page.screenshot({ path: out });
// Edit the newer version (the last pane) and check the edit is posted.
const last = (process.env.KEN_EDIT_PANE === "first" ? page.locator(".ken-diff-pane").first() : page.locator(".ken-diff-pane").last()).locator(".ProseMirror > p").first();
await last.click();
await page.keyboard.press("End");
await page.keyboard.type(" EDITED");
await page.waitForTimeout(600);
const edit = await page.evaluate(() => window.__sent.filter((m) => m.type === "diffEdit").pop());
console.log("edit", edit ? edit.side + " " + JSON.stringify(edit.text.slice(0, 120)) : "none");
await page.screenshot({ path: out.replace(/\.png$/, "-edited.png") });
const counts = await page.evaluate(() => ({
  added: document.querySelectorAll(".ken-diff-added").length,
  removed: document.querySelectorAll(".ken-diff-removed").length,
  words: document.querySelectorAll(".ken-diff-added-text, .ken-diff-removed-text").length,
}));
console.log(JSON.stringify({ out, counts, errors }));
await browser.close();
server.close();
