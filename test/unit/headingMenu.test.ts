import { afterEach, describe, expect, it, vi } from "vitest";

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
const item = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".ken-context-menu-item")].find((b) => b.textContent === label)!;

function rightClick(el: Element): MouseEvent {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  el.dispatchEvent(event);
  return event;
}

describe("heading context menu", () => {
  it("offers numbering and copy link on a heading", async () => {
    const onHeadingNumbering = vi.fn();
    mounted = await mountEditor("# Getting Started\n\nBody.\n", { onHeadingNumbering });
    const event = rightClick(mounted.root.querySelector(".ProseMirror h1")!);
    expect(event.defaultPrevented).toBe(true);
    expect(menuLabels()).toEqual(["Heading numbering…", "Copy link to heading"]);
    item("Heading numbering…").click();
    expect(onHeadingNumbering).toHaveBeenCalledOnce();
    expect(document.querySelector(".ken-context-menu")).toBeNull();
  });

  it("copies the heading's link", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    mounted = await mountEditor("# Intro\n\n## What's new?\n", { onHeadingNumbering: () => undefined });
    rightClick(mounted.root.querySelectorAll(".ProseMirror h2")[0]!);
    item("Copy link to heading").click();
    expect(writeText).toHaveBeenCalledWith("[What's new?](#whats-new)");
  });

  it("leaves the numbering item out when nothing handles it", async () => {
    mounted = await mountEditor("# Intro\n");
    rightClick(mounted.root.querySelector(".ProseMirror h1")!);
    expect(menuLabels()).toEqual(["Copy link to heading"]);
  });

  it("keeps the default menu elsewhere", async () => {
    mounted = await mountEditor("# Intro\n\nBody text.\n", { onHeadingNumbering: () => undefined });
    const event = rightClick(mounted.root.querySelector(".ProseMirror p")!);
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector(".ken-context-menu")).toBeNull();
  });
});
