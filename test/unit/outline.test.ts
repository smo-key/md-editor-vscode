// The outline sidebar (webview/outline.ts): the toolbar button, the heading
// list, the current-section rule, and the narrow-window overlay.
import { afterEach, describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import type { EditorView } from "@milkdown/kit/prose/view";

import { currentHeading, outlineOverlays } from "../../webview/outline";
import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();

const DOC = "# Title\n\nintro\n\n## Setup\n\ntext\n\n### Install\n\nmore\n\n## Usage\n\nend\n";

describe("currentHeading", () => {
  it("is the last heading at or above the reading line", () => {
    expect(currentHeading([10, 400, 900], 1000, false)).toBe(0);
    expect(currentHeading([-500, 200, 900], 1000, false)).toBe(1);
    expect(currentHeading([-900, -400, 240], 1000, false)).toBe(2);
  });

  it("is none above the first heading", () => {
    expect(currentHeading([400, 900], 1000, false)).toBe(-1);
  });

  it("is the last heading on screen once scrolled to the end", () => {
    expect(currentHeading([-900, 100, 700], 1000, true)).toBe(2);
    expect(currentHeading([-900, 100, 1200], 1000, true)).toBe(1);
  });
});

describe("outlineOverlays", () => {
  it("docks when the text keeps room, else overlays", () => {
    expect(outlineOverlays(1200, false)).toBe(false);
    expect(outlineOverlays(700, false)).toBe(true);
    // The comments sidebar takes its share too.
    expect(outlineOverlays(1000, false)).toBe(false);
    expect(outlineOverlays(1000, true)).toBe(true);
  });
});

describe("outline panel", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
    document.body.className = "";
  });

  async function mount(width: number) {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    const host = document.createElement("div");
    const scroll = document.createElement("div");
    document.body.append(host, scroll);
    const ed = await mountEditor(DOC, { toolbarHost: host, outlineScroll: scroll });
    cleanup = async () => {
      await ed.destroy();
      host.remove();
      scroll.remove();
    };
    const view: EditorView = ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
    const button = host.querySelector<HTMLButtonElement>('.ken-toolbar-button[data-id="outline"]')!;
    const panel = () => document.querySelector<HTMLElement>(".ken-outline")!;
    return { ed, view, host, button, panel };
  }

  it("sits left of undo/redo and lists the headings by depth", async () => {
    const { host, button, panel } = await mount(1400);
    const ids = [...host.querySelectorAll<HTMLElement>(".ken-toolbar-button")].map((b) => b.dataset.id);
    expect(ids.slice(0, 3)).toEqual(["outline", "undo", "redo"]);
    expect(panel().hidden).toBe(true);
    button.click();
    expect(panel().hidden).toBe(false);
    expect(document.body.classList.contains("outline-open")).toBe(true);
    expect(document.body.classList.contains("outline-overlay")).toBe(false);
    expect(button.classList.contains("active")).toBe(true);
    const items = [...panel().querySelectorAll<HTMLElement>(".ken-outline-item")];
    expect(items.map((i) => i.textContent)).toEqual(["Title", "Setup", "Install", "Usage"]);
    expect(items.map((i) => i.style.getPropertyValue("--depth"))).toEqual(["0", "1", "2", "1"]);
    button.click();
    expect(panel().hidden).toBe(true);
    expect(document.body.classList.contains("outline-open")).toBe(false);
    expect(button.classList.contains("active")).toBe(false);
  });

  it("follows heading edits", async () => {
    const { view, button, panel } = await mount(1400);
    button.click();
    const end = view.state.doc.content.size;
    view.dispatch(view.state.tr.insert(end, view.state.schema.nodes.heading.create({ level: 2 }, view.state.schema.text("Extra"))));
    const items = [...panel().querySelectorAll<HTMLElement>(".ken-outline-item")];
    expect(items.map((i) => i.textContent)).toEqual(["Title", "Setup", "Install", "Usage", "Extra"]);
  });

  it("overlays a narrow window and closes on Escape, outside clicks and a pick", async () => {
    const { view, button, panel } = await mount(600);
    button.click();
    expect(document.body.classList.contains("outline-overlay")).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel().hidden).toBe(true);
    expect(document.body.classList.contains("outline-overlay")).toBe(false);

    button.click();
    // A press inside it keeps it open; one on the text closes it.
    panel().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(panel().hidden).toBe(false);
    view.dom.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(panel().hidden).toBe(true);

    button.click();
    panel().querySelectorAll<HTMLButtonElement>(".ken-outline-item")[2].click();
    expect(panel().hidden).toBe(true);
    expect(view.state.selection.$from.parent.textContent).toBe("Install");
  });

  it("stays open in a wide window on Escape and outside clicks", async () => {
    const { view, button, panel } = await mount(1400);
    button.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    view.dom.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    panel().querySelectorAll<HTMLButtonElement>(".ken-outline-item")[1].click();
    expect(panel().hidden).toBe(false);
    expect(view.state.selection.$from.parent.textContent).toBe("Setup");
  });
});
