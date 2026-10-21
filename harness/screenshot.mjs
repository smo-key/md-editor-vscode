// Visual check: screenshots a document in the real webview bundle under a
// VS Code theme captured by the integration tests (KEN_DUMP_THEMES). Usage:
//   node harness/screenshot.mjs <theme.json> <markdown file> <out.png> [width] [fontSize]
import { readFileSync } from "fs";
import { openHarness } from "./harness.mjs";

const [themeFile, mdFile, out, width = "1100", fontSize = "16"] = process.argv.slice(2);
const h = await openHarness({ themeFile, markdown: readFileSync(mdFile, "utf8"), width: Number(width), fontSize });
await h.page.waitForTimeout(1500);
const height = await h.page.evaluate(() => document.getElementById("scroll").scrollHeight);
await h.page.setViewportSize({ width: Number(width), height: Math.min(height + 60, 6000) });
await h.page.screenshot({ path: out });
console.log(JSON.stringify({ out, errors: h.errors }));
await h.close();
