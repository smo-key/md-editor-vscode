// Inline Mermaid rendering for ```mermaid fences in the Markdown editor.
//
// Plugged into Crepe's CodeMirror feature as `renderPreview`. Mermaid is a big
// dependency, so it is only `import()`ed the first time a mermaid fence is
// seen; until then the editor bundle does not pay for it.
import type { CodeBlockConfig } from "@milkdown/kit/component/code-block";

type ApplyPreview = (value: null | string | HTMLElement) => void;
type Mermaid = typeof import("mermaid").default;

let mermaidPromise: Promise<Mermaid> | undefined;

function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import("mermaid").then((mod) => mod.default);
  return mermaidPromise;
}

/** VS Code marks the webview body with the active theme's kind. */
function isDark(): boolean {
  const c = document.body.classList;
  return c.contains("vscode-dark") || c.contains("vscode-high-contrast");
}

/**
 * Mermaid measures label widths in a detached element, where a `var(--font-*)`
 * reference would not resolve and every label would come out mis-sized, so the
 * token is resolved to its real font stack first.
 */
function fontFamily(): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-sans")
    .trim();
  return value || "system-ui, sans-serif";
}

let seq = 0;

// Mermaid keeps global configuration and mints DOM ids, so concurrent renders
// step on each other. Chaining every render also makes results land in call
// order, which is the stale-result guard: a render started earlier can never
// overwrite the output of a later one for the same block.
let queue: Promise<unknown> = Promise.resolve();

function errorElement(message: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "mermaid-error";
  el.textContent = message;
  return el;
}

async function renderMermaid(code: string): Promise<HTMLElement> {
  const mermaid = await loadMermaid();
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: isDark() ? "dark" : "default",
    fontFamily: fontFamily(),
  });

  // Parse first: `render` would otherwise inject its own error graphic into
  // the document, while `parse` just throws with a readable message.
  await mermaid.parse(code);

  const id = `ken-mermaid-${++seq}`;
  const { svg } = await mermaid.render(id, code);
  const host = document.createElement("div");
  host.className = "mermaid-preview";
  host.innerHTML = svg;
  return host;
}

/**
 * Crepe `renderPreview`: `null` for every language but `mermaid`; for mermaid
 * it returns `undefined` (Crepe's "async" signal) and calls `applyPreview`
 * once the diagram — or a compact inline error — is ready.
 */
export const renderMermaidPreview: CodeBlockConfig["renderPreview"] = (
  language: string,
  content: string,
  applyPreview: ApplyPreview,
) => {
  if (language?.toLowerCase() !== "mermaid") return null;
  if (!content.trim()) return null;

  queue = queue.then(async () => {
    try {
      applyPreview(await renderMermaid(content));
    } catch (err) {
      applyPreview(
        errorElement(err instanceof Error ? err.message : String(err)),
      );
    }
  });
  return undefined;
};

/** "Code" while the diagram is showing, "Diagram" while the source is showing. */
export function mermaidPreviewToggleText(previewOnlyMode: boolean): string {
  return previewOnlyMode ? "Code" : "Diagram";
}

/**
 * A diagram's SVG for a document leaving the editor (Word export): the light
 * theme (paper is white) and labels drawn as SVG text rather than HTML, which
 * other programs (and canvases) can't show.
 */
export function exportMermaidSvg(code: string): Promise<string | null> {
  const run = queue.then(async () => {
    try {
      const mermaid = await loadMermaid();
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "default",
        fontFamily: fontFamily(),
        htmlLabels: false,
        flowchart: { htmlLabels: false },
      });
      await mermaid.parse(code);
      const { svg } = await mermaid.render(`ken-mermaid-export-${++seq}`, code);
      return svg;
    } catch {
      return null;
    }
  });
  queue = run;
  return run;
}
