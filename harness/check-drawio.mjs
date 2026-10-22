// draw.io end to end in Chromium, against the real diagrams.net editor:
// insert a diagram, save one through the editor, see it in the document, and
// open it again for editing.   node harness/check-drawio.mjs <theme.json>
import assert from "node:assert/strict";
import { openHarness } from "./harness.mjs";

const h = await openHarness({ themeFile: process.argv[2], markdown: "# Doc\n\nIntro.\n", width: 1200, height: 800 });
const { page } = h;
const last = () => page.evaluate(() => window.__lastText());
const drawioFrame = async () => {
  for (let i = 0; i < 200; i++) {
    const f = page.frames().find((fr) => fr.url().startsWith("https://embed.diagrams.net/"));
    if (f) return f;
    await page.waitForTimeout(100);
  }
  throw new Error("no draw.io frame");
};
const XML =
  '<mxfile><diagram id="p" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="2" value="Hello from the test" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="160" height="60" as="geometry"/></mxCell>' +
  "</root></mxGraphModel></diagram></mxfile>";

// 1. Insert a new diagram with the slash menu: the editor opens on it.
await page.click(".ProseMirror p >> text=Intro.");
await page.keyboard.press("End");
await page.keyboard.press("Enter");
await page.keyboard.type("/drawio");
await page.keyboard.press("Enter");
await page.waitForSelector(".ken-drawio[data-ready='true']", { timeout: 30000 });
await page.waitForTimeout(300);
assert.match(await last(), /!\[\]\(_Images\/doc-diagram\.drawio\.svg\)/);

// 2. Save from inside draw.io (as its Save & Exit button does): the editor
//    exports the diagram as an editable SVG, which is written to the file.
const frame = await drawioFrame();
await frame.evaluate((xml) => window.parent.postMessage(JSON.stringify({ event: "save", xml, exit: true }), "*"), XML);
await page.waitForSelector(".ken-drawio", { state: "detached", timeout: 30000 });
const svg = await page.evaluate(() => new TextDecoder().decode(window.__files["_Images/doc-diagram.drawio.svg"]));
assert.match(svg, /^<svg|<\?xml/);
assert.match(svg, /content="/, "the diagram source is embedded");
assert.match(svg, /Hello from the test/, "the saved image shows the shape");
if (process.env.SAVE_FIXTURE) (await import("node:fs")).writeFileSync(process.env.SAVE_FIXTURE, svg);

// 3. The document shows the new picture.
await page.waitForTimeout(500);
const shown = await page.evaluate(async () => {
  const img = document.querySelector(".milkdown-image-block img");
  if (!img) return null;
  await img.decode?.().catch(() => undefined);
  return { w: img.naturalWidth, src: img.getAttribute("src") };
});
assert.ok(shown && shown.w > 1, `image shown: ${JSON.stringify(shown)}`);

// 4. Edit again from the image's button: the editor opens with the saved diagram.
await page.hover(".milkdown-image-block");
await page.click(".ken-drawio-edit");
await page.waitForSelector(".ken-drawio[data-ready='true']", { timeout: 30000 });
const frame2 = await drawioFrame();
let loaded = false;
for (let i = 0; i < 100 && !loaded; i++) {
  loaded = await frame2.evaluate(() => document.body.innerText.includes("Hello from the test")).catch(() => false);
  if (!loaded) await page.waitForTimeout(100);
}
assert.ok(loaded, "the existing diagram loads into the editor");
await frame2.evaluate(() => window.parent.postMessage(JSON.stringify({ event: "exit" }), "*"));
await page.waitForSelector(".ken-drawio", { state: "detached" });

assert.deepEqual(h.errors, []);
await page.screenshot({ path: "out/drawio-doc.png" });
await h.close();
console.log("ok: draw.io insert, save through diagrams.net, display, re-edit");
