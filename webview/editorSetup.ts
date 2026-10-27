/**
 * The editor itself: Crepe (Milkdown's batteries-included editor, with the
 * CommonMark and GitHub-flavoured Markdown presets) configured and extended
 * exactly as the shipped editor uses it. Kept apart from the webview wiring so the unit
 * tests exercise the same editor that ships.
 */
import { Crepe } from "@milkdown/crepe";
import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";

import { githubAlertPlugins } from "./markdown/githubAlert";
import { disableHeadingDowngrade, headingBackspace } from "./markdown/headingBackspace";
import { mermaidPreviewToggleText, renderMermaidPreview } from "./markdown/mermaid";
import { slashShortcutInputRule, slashShortcutKeys } from "./markdown/slashShortcuts";
import { anchorLinkPlugin } from "./markdown/anchors";
import { headingContextMenuPlugin, headingLinkPlugin } from "./markdown/headingLink";
import { headingNumbersPlugin } from "./markdown/headingNumbers";
import { wikiLinkPlugin, type LinkClick } from "./markdown/wikiLinks";
import { lucidPlugin, type LucidOptions } from "./markdown/lucid";
import type { HeadingNumbersConfig } from "../src/headingNumbers";
import { tableContextMenu } from "./markdown/tableMenu";
import { tableFullWidthPlugins } from "./markdown/tableFullWidth";
import { tocPlugins } from "./markdown/toc";
import { tableLayoutPlugin } from "./markdown/tableLayout";
import { tableCellBlockSchemas } from "./markdown/tableCellBlocks";
import { configureListDelimiter, listStylePlugins } from "./markdown/listStyles";
import { listJoinPlugin } from "./markdown/listJoin";
import { imageBlockAltSchema, tightListJoin } from "./markdown/gfmFidelity";
import { configureLinkText, linkFidelityPlugins } from "./markdown/linkFidelity";
import { markRunPlugins } from "./markdown/markRuns";
import { htmlViewPlugin, inlineHtmlPlugin } from "./markdown/htmlView";
import { vscodeCodeTheme } from "./codeTheme";
import { fileDropPlugin, type FileDropOptions } from "./fileDrop";
import { slashMenuPlugin } from "./slashMenu";
import { useTaskHandle } from "./taskHandle";
import { headingLevelKeys, tableCellClickFix, tableKeys } from "./tableKeys";
import { columnResizePlugin } from "./tableResize";
import { blockExitPlugin } from "./blockExit";
import { drawioPlugin } from "./drawio";
import { underlinePlugins } from "./markdown/underline";
import { configureMathText, isMathLanguage, mathPlugins, renderMathPreview } from "./markdown/math";
import { commentPlugins, commentSchemas } from "./comments/anchors";
import { threadStore } from "./comments/store";
import { toolbarPlugin } from "./toolbar";
import { blockSelectionKeys, blockSelectionPlugin, stableTableView } from "./markdown/blockSelection";
import { keySelectionSync } from "./keySelectionSync";
import { configureTabIndent } from "./markdown/plainTab";
import { codePasteExtension, codePastePlugin } from "./markdown/codePaste";
import { tablePastePlugin } from "./markdown/tablePaste";

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
  /** A comment's highlight was clicked (open its thread). */
  onCommentActivate?: (id: string | null) => void;
  /** Lucidchart previews (markdown/lucid.ts): the setting and the Edit/Open actions. */
  lucid?: LucidOptions;
  /** Heading numbers (markdown/headingNumbers.ts): the current setting, read at each rebuild. */
  headingNumbers?: () => HeadingNumbersConfig | undefined;
  /** "Heading numbering…" in a heading's context menu; the item is left out without it. */
  onHeadingNumbering?: () => void;
}

/** A configured, not yet created, editor: call `create()` on it. */
export function buildEditor(options: EditorOptions): Crepe {
  const crepe = new Crepe({
    root: options.root,
    defaultValue: options.markdown,
    features: {
      // Replaced by markdown/math.ts, whose `$…$` rules leave prices
      // ("$5 and $10") as text.
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
        renderPreview: (language, content, applyPreview) =>
          isMathLanguage(language)
            ? renderMathPreview(language, content, applyPreview)
            : renderMermaidPreview(language, content, applyPreview),
        // Only has an effect where a preview exists, i.e. mermaid fences.
        previewOnlyByDefault: true,
        previewToggleText: mermaidPreviewToggleText,
        // Follows the VS Code theme instead of Crepe's One Dark.
        theme: vscodeCodeTheme,
        // Text copied from the editor pastes as its rendered text (codePaste.ts).
        extensions: [codePasteExtension],
      },
      // Covers inline images too: Crepe hands the same config to both.
      // Only in a completely empty document (not on every empty line).
      [Crepe.Feature.Placeholder]: {
        text: "Start typing or try slash (/) commands",
        mode: "doc",
      },
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
  // Code and inline code get the clipboard's plain text, ahead of Milkdown's
  // Markdown parsing of pastes (its handlePaste runs after DOM handlers).
  crepe.editor.use(codePastePlugin);
  // Spreadsheet/CSV data and cell blocks paste as cells (markdown/tablePaste.ts).
  crepe.editor.use(tablePastePlugin);
  const onLink = options.onLink ?? (() => false);
  crepe.editor.use(githubAlertPlugins);
  crepe.editor.use(underlinePlugins);
  crepe.editor.use(commentSchemas);
  crepe.editor.use(
    commentPlugins(
      {
        isResolved: (id) => threadStore.get(id)?.resolved === true,
        exists: (id) => threadStore.has(id),
      },
      (id) => options.onCommentActivate?.(id),
    ),
  );
  crepe.editor.use(headingBackspace);
  crepe.editor.use(slashShortcutInputRule);
  crepe.editor.use(anchorLinkPlugin);
  crepe.editor.use(headingLinkPlugin);
  crepe.editor.use(headingContextMenuPlugin(options.onHeadingNumbering));
  crepe.editor.use(headingNumbersPlugin(options.headingNumbers));
  crepe.editor.use(wikiLinkPlugin(onLink, () => false));
  // A Lucid link alone in its paragraph shows a preview under it (decorations only).
  crepe.editor.use(lucidPlugin(options.lucid));
  // Order matters: these replace preset nodes, so they register after them.
  crepe.editor.use(tableFullWidthPlugins);
  crepe.editor.use(mathPlugins);
  crepe.editor.config(configureMathText);
  crepe.editor.use(tocPlugins);
  crepe.editor.use(listStylePlugins);
  crepe.editor.config(configureListDelimiter);
  // Lists left touching become one list (markdown/listJoin.ts).
  crepe.editor.use(listJoinPlugin);
  crepe.editor.use(tableLayoutPlugin);
  crepe.editor.use(columnResizePlugin);
  crepe.editor.use(blockExitPlugin);
  crepe.editor.use(drawioPlugin);
  crepe.editor.use(tableContextMenu);
  // After Crepe's image block feature: replaces its schema by name.
  crepe.editor.use(imageBlockAltSchema);
  // Cells hold paragraphs and lists, written as `<br>` and inline HTML lists.
  crepe.editor.use(tableCellBlockSchemas);
  crepe.editor.use(linkFidelityPlugins);
  crepe.editor.config(configureLinkText);
  // One emphasis span stays one span around a link, code or nested mark.
  crepe.editor.use(markRunPlugins);
  // Raw HTML renders as GitHub shows it, and is editable as source.
  crepe.editor.use(htmlViewPlugin(options.proxyDomURL));
  crepe.editor.use(inlineHtmlPlugin);
  crepe.editor.use(slashMenuPlugin);
  // After the menu: while it is open, Enter runs its highlighted item.
  crepe.editor.use(slashShortcutKeys);
  crepe.editor.use(tableKeys);
  crepe.editor.use(headingLevelKeys);
  crepe.editor.use(tableCellClickFix);
  // Selections reaching images, tables, diagrams and code take them whole.
  crepe.editor.use(blockSelectionPlugin);
  crepe.editor.use(stableTableView);
  crepe.editor.config(blockSelectionKeys);
  // After every other view-level key handler, so it wraps them and runs first.
  crepe.editor.config(keySelectionSync);
  useTaskHandle(crepe.editor);
  if (options.toolbarHost) crepe.editor.use(toolbarPlugin(options.toolbarHost));
  crepe.editor.config(disableHeadingDowngrade);
  crepe.editor.config(configureTabIndent);
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
