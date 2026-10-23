// Visual check of the What's New page (src/whatsNew.ts) outside VS Code,
// simulating an update with the real CHANGELOG.md. Usage:
//   node harness/screenshot-whats-new.mjs <out.png> [dark|light|<theme.json>] [from=0.3.2] [to=package.json version] [width=900]
// A theme JSON is one captured by the integration tests (KEN_DUMP_THEMES);
// `dark` / `light` use a built-in subset of Default Dark/Light Modern.
import { build } from "esbuild";
import { readFileSync } from "fs";
import { chromium } from "playwright";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const [out, theme = "dark", from = "0.3.2", to = pkg.version, width = "900"] = process.argv.slice(2);
if (!out) throw new Error("usage: node harness/screenshot-whats-new.mjs <out.png> [dark|light|theme.json] [from] [to] [width]");

const font = "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, sans-serif";
const mono = "Menlo, Monaco, 'Courier New', monospace";
const THEMES = {
  dark: {
    "editor-background": "#1f1f1f", "editor-foreground": "#cccccc", foreground: "#cccccc",
    descriptionForeground: "#9d9d9d", "widget-border": "#313131", "panel-border": "#2b2b2b",
    "textCodeBlock-background": "#2b2b2b", "textLink-foreground": "#4daafc", "textLink-activeForeground": "#4daafc",
    "button-background": "#0078d4", "button-foreground": "#ffffff", "button-hoverBackground": "#026ec1",
    "button-border": "#ffffff12", "button-secondaryBackground": "#313131", "button-secondaryForeground": "#cccccc",
    "button-secondaryHoverBackground": "#3c3c3c", focusBorder: "#0078d4",
    "keybindingLabel-background": "#8080802b", "keybindingLabel-foreground": "#cccccc",
    "keybindingLabel-border": "#33333399", "keybindingLabel-bottomBorder": "#44444499",
    "charts-blue": "#3794ff", "charts-green": "#89d185", "charts-orange": "#d18616", "charts-red": "#f14c4c", "charts-yellow": "#cca700",
  },
  light: {
    "editor-background": "#ffffff", "editor-foreground": "#3b3b3b", foreground: "#3b3b3b",
    descriptionForeground: "#616161", "widget-border": "#e5e5e5", "panel-border": "#e5e5e5",
    "textCodeBlock-background": "#f2f2f2", "textLink-foreground": "#005fb8", "textLink-activeForeground": "#005fb8",
    "button-background": "#005fb8", "button-foreground": "#ffffff", "button-hoverBackground": "#0258a8",
    "button-border": "#0000001a", "button-secondaryBackground": "#e5e5e5", "button-secondaryForeground": "#3b3b3b",
    "button-secondaryHoverBackground": "#cccccc", focusBorder: "#005fb8",
    "keybindingLabel-background": "#dddddd66", "keybindingLabel-foreground": "#3b3b3b",
    "keybindingLabel-border": "#cccccc66", "keybindingLabel-bottomBorder": "#bbbbbb66",
    "charts-blue": "#1a85ff", "charts-green": "#388a34", "charts-orange": "#d18616", "charts-red": "#e51400", "charts-yellow": "#bf8803",
  },
};
const style = THEMES[theme]
  ? Object.entries({ ...THEMES[theme], "font-family": font, "font-size": "13px", "editor-font-family": mono })
      .map(([k, v]) => `--vscode-${k}: ${v};`)
      .join(" ")
  : JSON.parse(readFileSync(theme, "utf8")).style;

// Bundle the pure TypeScript module in memory and import it.
const bundle = await build({ entryPoints: ["src/whatsNew.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { parseChangelog, sectionsFor, whatsNewHtml } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const sections = sectionsFor(parseChangelog(readFileSync("CHANGELOG.md", "utf8")), from, to);
const html = whatsNewHtml({ version: to, previous: from, sections, nonce: "harness" }).replace(
  '<html lang="en">',
  `<html lang="en" style="${style.replace(/"/g, "&quot;")}">`,
);

// Playwright's Chromium, or the installed Chrome if it hasn't been downloaded.
const browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
const page = await browser.newPage({ viewport: { width: Number(width), height: 600 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.setContent(html);
await page.screenshot({ path: out, fullPage: true });
console.log(JSON.stringify({ out, sections: sections.map((s) => s.version), errors }));
await browser.close();
