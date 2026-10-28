// Right-click on an image: caption, show the file, delete.
import { afterEach, describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";

import { closeContextMenu } from "../../webview/contextMenu";
import { normalizeTrailingNewlines } from "../../webview/markdown/gfmFidelity";
import { OS_FILE_MANAGER, type RevealTarget } from "../../webview/markdown/imageMenu";
import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();
afterEach(() => closeContextMenu());

async function withImage(markdown: string, fn: (open: () => string[], pick: (label: string) => void, md: () => string, revealed: [string, RevealTarget][]) => void | Promise<void>) {
  const revealed: [string, RevealTarget][] = [];
  const ed = await mountEditor(markdown, {
    imageMenu: { reveal: (src, where) => revealed.push([src, where]), isLocal: (src) => !/^https?:/.test(src) },
  });
  ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
  await new Promise((r) => setTimeout(r, 0));
  const open = () => {
    const block = ed.root.querySelector(".milkdown-image-block img")!;
    block.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    return [...document.querySelectorAll(".ken-context-menu [role=menuitem], .ken-context-menu button")].map((b) => b.textContent!.trim());
  };
  const pick = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(".ken-context-menu button")].find((b) => b.textContent!.trim() === label)!.click();
  try {
    await fn(open, pick, () => normalizeTrailingNewlines(ed.markdown()), revealed);
  } finally {
    await ed.destroy();
  }
}

describe("image context menu", () => {
  it("offers caption, show-in and delete; deletes the image", async () => {
    await withImage("Before\n\n![](pics/a.png)\n\nAfter\n", (open, pick, md) => {
      expect(open()).toEqual(["Cut", "Copy", "Add caption", `Show in ${OS_FILE_MANAGER}`, "Show in Explorer", "Delete image"]);
      pick("Delete image");
      expect(md()).toBe("Before\n\nAfter\n");
    });
  });

  it("removes a caption", async () => {
    await withImage('![](a.png "A caption")\n', (open, pick, md) => {
      expect(open()[2]).toBe("Remove caption");
      pick("Remove caption");
      expect(md()).not.toContain("A caption");
    });
  });

  it("shows a local file in the file manager or Explorer; not a web image", async () => {
    await withImage("![](pics/a.png)\n\n![](https://example.com/b.png)\n", (open, pick, _md, revealed) => {
      open();
      pick(`Show in ${OS_FILE_MANAGER}`);
      open();
      pick("Show in Explorer");
      expect(revealed).toEqual([["pics/a.png", "os"], ["pics/a.png", "explorer"]]);
    });
  });

  it("copies and cuts the image (Markdown on the clipboard when the browser's copy isn't available)", async () => {
    const written: string[] = [];
    const exec = document.execCommand;
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    document.execCommand = () => false;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void written.push(t) } });
    try {
      await withImage('Before\n\n![A chart](pics/a.png "Cap")\n\nAfter\n', (open, pick, md) => {
        open();
        pick("Copy");
        expect(written).toEqual(['![A chart](pics/a.png "Cap")']);
        expect(md()).toContain("pics/a.png");
        open();
        pick("Cut");
        expect(written).toHaveLength(2);
        expect(md()).toBe("Before\n\nAfter\n");
      });
    } finally {
      document.execCommand = exec;
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    }
  });
});

