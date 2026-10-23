import { afterEach, describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { undo } from "@milkdown/kit/prose/history";

import { closeContextMenu } from "../../webview/contextMenu";
import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();

let mounted: Awaited<ReturnType<typeof mountEditor>> | undefined;
afterEach(async () => {
  closeContextMenu();
  await mounted?.destroy();
  mounted = undefined;
});

const menuLabels = () => [...document.querySelectorAll(".ken-context-menu-item")].map((b) => b.textContent);
const item = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".ken-context-menu-item")].find((b) => b.textContent === label)!;

function rightClick(el: Element): MouseEvent {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  el.dispatchEvent(event);
  return event;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

const DOC = [
  "# Title",
  "",
  "Intro.",
  "",
  "<!-- ken:toc -->",
  "- [Setup](#setup)",
  "  - [Install](#install)",
  "- [Usage](#usage)",
  "",
  "## Setup",
  "",
  "### Install",
  "",
  "## Usage",
  "",
].join("\n");

const WITHOUT_TOC = ["# Title", "", "Intro.", "", "## Setup", "", "### Install", "", "## Usage", ""].join("\n");

describe("table of contents context menu", () => {
  it("opens over any part of the table of contents and blocks the default menu", async () => {
    mounted = await mountEditor(DOC);
    await settle();
    expect(mounted.markdown()).toBe(DOC);
    const nested = mounted.root.querySelector(".ProseMirror ul.ken-toc ul a, .ProseMirror ul.ken-toc ul li")!;
    expect(nested).toBeTruthy();
    const event = rightClick(nested);
    expect(event.defaultPrevented).toBe(true);
    expect(menuLabels()).toEqual(["Delete table of contents"]);
  });

  it("deletes exactly the table of contents, and one undo restores it", async () => {
    mounted = await mountEditor(DOC);
    await settle();
    rightClick(mounted.root.querySelector(".ProseMirror ul.ken-toc")!);
    item("Delete table of contents").click();
    expect(document.querySelector(".ken-context-menu")).toBeNull();
    expect(mounted.root.querySelector(".ProseMirror ul.ken-toc")).toBeNull();
    expect(mounted.markdown()).toBe(WITHOUT_TOC);

    const view = mounted.crepe.editor.ctx.get(editorViewCtx);
    expect(undo(view.state, view.dispatch)).toBe(true);
    await settle();
    expect(mounted.markdown()).toBe(DOC);
    expect(mounted.root.querySelector(".ProseMirror ul.ken-toc")).toBeTruthy();
  });

  it("deletes a table of contents at the end of the document", async () => {
    const doc = "# Title\n\n## A\n\n<!-- ken:toc -->\n- No headings yet\n";
    mounted = await mountEditor(doc);
    await settle();
    // Crepe keeps a trailing empty paragraph after a final list; whatever
    // surrounds the table of contents, only its own lines go.
    const before = mounted.markdown();
    expect(before.startsWith(doc)).toBe(true);
    rightClick(mounted.root.querySelector(".ProseMirror ul.ken-toc")!);
    item("Delete table of contents").click();
    expect(mounted.markdown()).toBe(before.replace("<!-- ken:toc -->\n- No headings yet\n\n", ""));
  });

  it("closes on Escape without deleting", async () => {
    mounted = await mountEditor(DOC);
    await settle();
    rightClick(mounted.root.querySelector(".ProseMirror ul.ken-toc")!);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(document.querySelector(".ken-context-menu")).toBeNull();
    expect(mounted.markdown()).toBe(DOC);
  });

  it("leaves an ordinary bullet list alone", async () => {
    mounted = await mountEditor("- one\n- two\n");
    await settle();
    const event = rightClick(mounted.root.querySelector(".ProseMirror li")!);
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector(".ken-context-menu")).toBeNull();
  });
});
