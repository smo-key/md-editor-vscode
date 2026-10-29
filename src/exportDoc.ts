/**
 * Export: the document as an HTML page (what Print shows, without printing),
 * a PDF of that page, or a Word document on the Ken Markdown template
 * (media/export-template.docx, src/docx.ts).
 *
 * The PDF is printed by a Chromium-based browser installed on the machine
 * (Chrome, Edge, Chromium, Brave; or `kenMarkdown.export.browserPath`), run
 * headless. Without one, the page opens in the default browser with its print
 * dialog, where "Save as PDF" does the same.
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";

import { markdownToDocx, type ImageData } from "./docx";
import { withAutoPrint } from "./printScript";
import type { ExportAsset } from "./protocol";

export type ExportFormat = "html" | "pdf" | "docx";

interface FormatItem extends vscode.QuickPickItem {
  format: ExportFormat;
}

const FORMATS: FormatItem[] = [
  { format: "html", label: "$(globe) HTML", description: ".html", detail: "A web page that looks exactly like the editor: theme, fonts, diagrams and images included." },
  { format: "pdf", label: "$(file-pdf) PDF", description: ".pdf", detail: "The same page, printed to PDF." },
  { format: "docx", label: "$(file) Word", description: ".docx", detail: "A Word document styled with the Ken Markdown template." },
];

/** Ask which format, on the Command Palette's picker. */
export async function pickFormat(): Promise<ExportFormat | undefined> {
  const pick = await vscode.window.showQuickPick(FORMATS, { title: "Export", placeHolder: "Export the document as…", matchOnDetail: true });
  return pick?.format;
}

/** Ask where to save, next to the document by default. */
export async function pickTarget(doc: vscode.Uri, format: ExportFormat): Promise<vscode.Uri | undefined> {
  const base = path.posix.basename(doc.path).replace(/\.(md|markdown)$/i, "");
  const dir = doc.scheme === "file" ? vscode.Uri.joinPath(doc, "..") : vscode.workspace.workspaceFolders?.[0]?.uri;
  const name = `${base}.${format}`;
  const filters: Record<ExportFormat, Record<string, string[]>> = {
    html: { "Web page": ["html"] },
    pdf: { PDF: ["pdf"] },
    docx: { "Word document": ["docx"] },
  };
  return vscode.window.showSaveDialog({
    title: `Export as ${format.toUpperCase()}`,
    saveLabel: "Export",
    defaultUri: dir ? vscode.Uri.joinPath(dir, name) : undefined,
    filters: filters[format],
  });
}

/** Chromium-based browsers that can print a page to PDF headless. */
export function browserCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === "darwin") {
    return ["Google Chrome", "Microsoft Edge", "Chromium", "Brave Browser", "Google Chrome Canary"].flatMap((app) => [
      `/Applications/${app}.app/Contents/MacOS/${app}`,
      path.join(os.homedir(), `Applications/${app}.app/Contents/MacOS/${app}`),
    ]);
  }
  if (platform === "win32") {
    const roots = [env["PROGRAMFILES(X86)"], env.PROGRAMFILES, env.LOCALAPPDATA].filter((r): r is string => !!r);
    return roots.flatMap((r) => [
      path.join(r, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(r, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(r, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ]);
  }
  const dirs = (env.PATH ?? "/usr/bin").split(":");
  return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"].flatMap((b) => dirs.map((d) => path.join(d, b)));
}

export function findBrowser(): string | undefined {
  const configured = vscode.workspace.getConfiguration("kenMarkdown").get<string>("export.browserPath", "").trim();
  if (configured) return fs.existsSync(configured) ? configured : undefined;
  return browserCandidates().find((p) => fs.existsSync(p));
}

/** Print `html` to `pdf` with a headless browser. */
export async function htmlToPdf(browser: string, html: string, pdf: string): Promise<void> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ken-export-"));
  const page = path.join(dir, "page.html");
  await fs.promises.writeFile(page, html, "utf8");
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        browser,
        [
          "--headless=new",
          "--disable-gpu",
          "--no-first-run",
          "--no-default-browser-check",
          "--no-pdf-header-footer",
          "--run-all-compositor-stages-before-draw",
          "--virtual-time-budget=10000",
          `--user-data-dir=${path.join(dir, "profile")}`,
          `--print-to-pdf=${pdf}`,
          vscode.Uri.file(page).toString(),
        ],
        { timeout: 120_000 },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    if (!fs.existsSync(pdf)) throw new Error("the browser did not write the PDF");
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** An image the document references, for the Word export: PNG, JPEG or GIF only. */
async function loadImage(doc: vscode.Uri, src: string): Promise<ImageData | null> {
  let bytes: Uint8Array | null = null;
  if (/^https?:/i.test(src)) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      const res = await fetch(src, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) bytes = new Uint8Array(await res.arrayBuffer());
    } catch {
      return null;
    }
  } else if (!/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("#")) {
    try {
      const rel = decodeURIComponent(src.split(/[?#]/)[0]!);
      const uri = rel.startsWith("/") ? (vscode.workspace.getWorkspaceFolder(doc)?.uri ?? doc).with({ path: rel }) : vscode.Uri.joinPath(doc, "..", rel);
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      return null;
    }
  }
  if (!bytes || bytes.length < 8) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return { data: bytes, ext: "png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { data: bytes, ext: "jpeg" };
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return { data: bytes, ext: "gif" };
  return null;
}

export interface ExportRequest {
  format: ExportFormat;
  target: vscode.Uri;
  /** The print page (no print dialog), from the webview. */
  html: string;
  document: vscode.TextDocument;
  extensionUri: vscode.Uri;
  /** Opens an http(s) or file URL outside VS Code. */
  openExternal: (url: string) => Thenable<boolean>;
  /** Pictures the webview made for the Word export (diagrams, SVG images). */
  assets?: { images: Record<string, ExportAsset>; diagrams: (ExportAsset | null)[] };
}

/**
 * A picture for Word: the PNG the editor drew whenever there is one. Word
 * draws an SVG itself, and badly (no HTML text such as draw.io's labels, no
 * stylesheet such as the one stroking Mermaid's lines), so an SVG goes in only
 * when there's no PNG.
 */
const asImage = (a: ExportAsset | null | undefined): ImageData | null =>
  a
    ? a.png
      ? { data: new Uint8Array(a.png), ext: "png", width: a.width, height: a.height }
      : { svg: a.svg, width: a.width, height: a.height }
    : null;

/** Write the export. Returns false when the PDF fell back to the browser's print dialog. */
export async function writeExport(req: ExportRequest): Promise<boolean> {
  const { format, target, html, document } = req;
  if (format === "html") {
    await vscode.workspace.fs.writeFile(target, Buffer.from(html, "utf8"));
    return true;
  }
  if (format === "pdf") {
    const browser = findBrowser();
    if (!browser || target.scheme !== "file") {
      const file = vscode.Uri.file(path.join(os.tmpdir(), `ken-print-${Date.now()}.html`));
      await vscode.workspace.fs.writeFile(file, Buffer.from(withAutoPrint(html), "utf8"));
      await req.openExternal(file.toString());
      return false;
    }
    await htmlToPdf(browser, html, target.fsPath);
    return true;
  }
  const template = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(req.extensionUri, "media", "export-template.docx"));
  const title = path.posix.basename(document.uri.path).replace(/\.(md|markdown)$/i, "");
  const assets = req.assets;
  const bytes = await markdownToDocx(document.getText(), template, {
    title,
    loadImage: async (src) => asImage(assets?.images[src]) ?? (await loadImage(document.uri, src)),
    diagram: (i) => asImage(assets?.diagrams[i]),
  });
  await vscode.workspace.fs.writeFile(target, bytes);
  return true;
}
