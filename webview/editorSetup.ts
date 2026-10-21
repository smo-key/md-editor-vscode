/**
 * The editor itself: Crepe (Milkdown's batteries-included editor, with the
 * CommonMark and GitHub-flavoured Markdown presets) configured and extended
 * exactly as Ken configures it. Kept apart from the webview wiring so the unit
 * tests exercise the same editor that ships.
 */
import { Crepe } from "@milkdown/crepe";
import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";

import { githubAlertPlugins } from "./markdown/githubAlert";
import { disableHeadingDowngrade, headingBackspace } from "./markdown/headingBackspace";
import { mermaidPreviewToggleText, renderMermaidPreview } from "./markdown/mermaid";
import { slashShortcutInputRule, slashShortcutKeys } from "./markdown/slashShortcuts";
import { anchorLinkPlugin } from "./markdown/anchors";
import { headingLinkPlugin } from "./markdown/headingLink";
import { wikiLinkPlugin, type LinkClick } from "./markdown/wikiLinks";
import { tableContextMenu } from "./markdown/tableMenu";
import { tableFullWidthPlugins } from "./markdown/tableFullWidth";
import { tocPlugins } from "./markdown/toc";
import { tableLayoutPlugin } from "./markdown/tableLayout";
import { configureListDelimiter, listStylePlugins } from "./markdown/listStyles";
import { emptyTableCellSchemas, imageBlockAltSchema, tightListJoin } from "./markdown/gfmFidelity";
import { htmlViewPlugin, inlineHtmlPlugin } from "./markdown/htmlView";
import { vscodeCodeTheme } from "./codeTheme";
import { fileDropPlugin, type FileDropOptions } from "./fileDrop";
import { slashMenuPlugin } from "./slashMenu";
import { useTaskHandle } from "./taskHandle";
import { tableCellClickFix, tableKeys } from "./tableKeys";
import { toolbarPlugin } from "./toolbar";

export interface EditorOptions {
  root: HTMLElement;
  markdown: string;
  /** A link was clicked: follow it and say whether it was followed. */
  onLink?: (link: LinkClick) => boolean;
  /** Saving and linking pasted/dropped files (fileDrop.ts); Crepe's blob: uploader otherwise. */
  fileDrop?: FileDropOptions;
  /** The image block's own Upload button. */
  onUpload?: (file: File) => Promise<string>;
  /** Display URL for an image src (document-relative paths need one). */
  proxyDomURL?: (src: string) => string | Promise<string>;
  /** Where to mount the bottom toolbar; none without it. */
  toolbarHost?: HTMLElement;
}

/** A configured, not yet created, editor: call `create()` on it. */
export function buildEditor(options: EditorOptions): Crepe {
  const crepe = new Crepe({
    root: options.root,
    defaultValue: options.markdown,
    features: {
      // `$…$` (two dollar amounts in a sentence) stays literal text.
      [Crepe.Feature.Latex]: false,
      // Crepe's block handle, "+" button and slash menu are replaced by
      // slashMenu.ts, taskHandle.ts (checklists only) and the bottom toolbar.
      [Crepe.Feature.BlockEdit]: false,
      // No formatting bubble over selected text: the bottom toolbar and the
      // keyboard shortcuts cover it.
      [Crepe.Feature.Toolbar]: false,
    },
    featureConfigs: {
      [Crepe.Feature.CodeMirror]: {
        renderPreview: renderMermaidPreview,
        // Only has an effect where a preview exists, i.e. mermaid fences.
        previewOnlyByDefault: true,
        previewToggleText: mermaidPreviewToggleText,
        // Follows the VS Code theme instead of Crepe's One Dark.
        theme: vscodeCodeTheme,
      },
      // Covers inline images too: Crepe hands the same config to both.
      [Crepe.Feature.ImageBlock]: {
        ...(options.onUpload ? { onUpload: options.onUpload } : {}),
        ...(options.proxyDomURL ? { proxyDomURL: options.proxyDomURL } : {}),
      },
    },
  });
  // Pasted and dropped files: saved beside the document and linked or shown,
  // placed without splitting the line (fileDrop.ts). Ahead of Milkdown's own
  // upload plugin, which is left with nothing to do.
  if (options.fileDrop) crepe.editor.use(fileDropPlugin(options.fileDrop));
  const onLink = options.onLink ?? (() => false);
  crepe.editor.use(githubAlertPlugins);
  crepe.editor.use(headingBackspace);
  crepe.editor.use(slashShortcutInputRule);
  crepe.editor.use(slashShortcutKeys);
  crepe.editor.use(anchorLinkPlugin);
  crepe.editor.use(headingLinkPlugin);
  crepe.editor.use(wikiLinkPlugin(onLink, () => false));
  // Order matters: these replace preset nodes, so they register after them.
  crepe.editor.use(tableFullWidthPlugins);
  crepe.editor.use(tocPlugins);
  crepe.editor.use(listStylePlugins);
  crepe.editor.config(configureListDelimiter);
  crepe.editor.use(tableLayoutPlugin);
  crepe.editor.use(tableContextMenu);
  // After Crepe's image block feature: replaces its schema by name.
  crepe.editor.use(imageBlockAltSchema);
  crepe.editor.use(emptyTableCellSchemas);
  // Raw HTML renders as GitHub shows it, and is editable as source.
  crepe.editor.use(htmlViewPlugin(options.proxyDomURL));
  crepe.editor.use(inlineHtmlPlugin);
  crepe.editor.use(slashMenuPlugin);
  crepe.editor.use(tableKeys);
  crepe.editor.use(tableCellClickFix);
  useTaskHandle(crepe.editor);
  if (options.toolbarHost) crepe.editor.use(toolbarPlugin(options.toolbarHost));
  crepe.editor.config(disableHeadingDowngrade);
  // House style is `- ` bullets; remark-stringify would otherwise write `*`.
  // Tight lists are kept tight (see gfmFidelity.ts).
  crepe.editor.config((ctx) => {
    ctx.update(remarkStringifyOptionsCtx, (opts) => ({
      ...opts,
      bullet: "-" as const,
      join: [...(opts.join ?? []), tightListJoin as NonNullable<typeof opts.join>[number]],
    }));
  });
  return crepe;
}
