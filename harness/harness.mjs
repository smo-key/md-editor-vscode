// Loads the real webview bundle (dist/webview) in Chromium with a VS Code
// theme captured from a real VS Code, standing in for the extension host.
import { chromium } from "playwright";
import { readFileSync } from "fs";
import { createServer } from "http";
import { extname, join, resolve } from "path";

const types = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png" };

export async function openHarness({ themeFile, markdown, width = 1100, height = 900, fontSize = 16, beforeLoad }) {
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
    if (window.__hostHook && /^collab/.test(m.type)) window.__hostHook(m.type, m.data ? (() => { let s = ""; for (const c of m.data) s += String.fromCharCode(c); return btoa(s); })() : null, m.writer ?? null);
    if (m.type === "ready") setTimeout(() => window.postMessage({ type: "init", text: ${JSON.stringify(markdown)}, docPath: "doc.md",
      config: { fontSize: ${Number(fontSize)}, bodyFontFamily: "", headingFontFamily: "", codeFontFamily: "", lineHeight: 1.85, maxWidth: 720, toolbar: "${process.env.KEN_TOOLBAR ?? "top"}", alwaysShowProperties: ${process.env.KEN_ALWAYS_PROPS === "1"}, lucidchart: { preview: "${process.env.KEN_LUCID_PREVIEW ?? "auto"}" }, tabSize: ${Number(process.env.KEN_TAB_SIZE ?? 4)} } }, "*"));
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
    // draw.io: files by root-relative path, kept in memory.
    window.__files = window.__files || {};
    if (m.type === "readFile") (async () => {
      let data = window.__files[m.path];
      if (!data) { const r = await fetch("/test/fixtures/" + m.path); data = r.ok ? new Uint8Array(await r.arrayBuffer()) : undefined; }
      window.postMessage({ type: "fileRead", id: m.id, data, error: data ? undefined : "not found" }, "*");
    })();
    if (m.type === "writeFile") {
      window.__files[m.path] = m.data;
      window.__saved = window.__saved || {};
      window.__saved[m.path] = URL.createObjectURL(new Blob([m.data], { type: m.path.endsWith(".png") ? "image/png" : "image/svg+xml" }));
      setTimeout(() => window.postMessage({ type: "fileWritten", id: m.id }, "*"));
    }
    if (m.type === "createDiagram") {
      const path = "_Images/doc-diagram.drawio.svg";
      const blank = '<svg xmlns="http://www.w3.org/2000/svg" width="1px" height="1px" viewBox="-0.5 -0.5 1 1" content="&lt;mxfile&gt;&lt;diagram id=&quot;p&quot; name=&quot;Page-1&quot;&gt;&lt;mxGraphModel&gt;&lt;root&gt;&lt;mxCell id=&quot;0&quot;/&gt;&lt;mxCell id=&quot;1&quot; parent=&quot;0&quot;/&gt;&lt;/root&gt;&lt;/mxGraphModel&gt;&lt;/diagram&gt;&lt;/mxfile&gt;"><g/></svg>';
      window.__files[path] = new TextEncoder().encode(blank);
      window.__saved = window.__saved || {};
      window.__saved[path] = URL.createObjectURL(new Blob([blank], { type: "image/svg+xml" }));
      setTimeout(() => window.postMessage({ type: "diagramCreated", id: m.id, path }, "*"));
    }
    // Files written in this page are served over HTTP (see page.route below),
    // like VS Code's resource URLs, so a cache-busting ?v= works.
    if (m.type === "resolve") setTimeout(() => window.postMessage({ type: "resolved", id: m.id,
      url: (window.__files && window.__files[m.path]) ? "/__files/" + m.path : (window.__saved && window.__saved[m.path]) || "/test/fixtures/" + m.path }, "*"));
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
  // A regular browser user agent: some services (diagrams.net) refuse "HeadlessChrome".
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 2,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });
  await page.route("**/__files/**", async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname.slice("/__files/".length));
    const b64 = await page.evaluate((p) => {
      const d = window.__files?.[p];
      if (!d) return null;
      let s = "";
      for (const c of d) s += String.fromCharCode(c);
      return btoa(s);
    }, path);
    if (!b64) return route.fulfill({ status: 404 });
    await route.fulfill({ status: 200, contentType: path.endsWith(".png") ? "image/png" : "image/svg+xml", body: Buffer.from(b64, "base64") });
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  if (beforeLoad) await beforeLoad(page);
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
