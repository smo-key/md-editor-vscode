// happy-dom lacks a few layout APIs ProseMirror, Crepe and the table layout
// call; stub them so the real editor (webview/editorSetup.ts) mounts headlessly.
import { beforeAll } from "vitest";
import { buildEditor, type EditorOptions } from "../../webview/editorSetup";

export function stubLayout() {
  beforeAll(() => {
    const range = globalThis.Range.prototype as unknown as Record<string, unknown>;
    range.getClientRects ??= () => [];
    range.getBoundingClientRect ??= () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
    const el = globalThis.Element.prototype as unknown as Record<string, unknown>;
    el.getClientRects ??= () => [];
    const probe = document.createElement("table");
    probe.innerHTML = "<tbody><tr><td></td></tr></tbody>";
    if (!probe.tBodies?.[0]?.rows) {
      Object.defineProperty(HTMLElement.prototype, "rows", {
        configurable: true,
        get(this: HTMLElement) {
          return this.querySelectorAll(":scope > tr, :scope > tbody > tr, :scope > thead > tr");
        },
      });
    }
    if (!probe.tBodies) {
      Object.defineProperty(HTMLTableElement.prototype, "tBodies", {
        configurable: true,
        get(this: HTMLTableElement) {
          return this.querySelectorAll(":scope > tbody");
        },
      });
    }
  });
}

export async function mountEditor(markdown: string, options: Partial<EditorOptions> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const crepe = buildEditor({ root, markdown, ...options });
  await crepe.create();
  return {
    root,
    crepe,
    markdown: () => crepe.getMarkdown(),
    // Crepe's list items dispatch on an animation frame; let them settle first.
    async destroy() {
      for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      await crepe.destroy();
      root.remove();
    },
  };
}
