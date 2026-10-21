/**
 * The editor itself: Crepe (Milkdown's batteries-included editor, with the
 * CommonMark and GitHub-flavoured Markdown presets) configured and extended
 * exactly as Ken configures it. Kept apart from the webview wiring so the unit
 * tests exercise the same editor that ships.
 */
import { Crepe } from "@milkdown/crepe";
import { editorViewCtx, remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { TextSelection } from "@milkdown/kit/prose/state";
import { uploadConfig, type Uploader } from "@milkdown/kit/plugin/upload";
import { blockquoteSchema, paragraphSchema } from "@milkdown/kit/preset/commonmark";

import { addGithubAlertMenuGroup, githubAlertPlugins } from "./markdown/githubAlert";
import { disableHeadingDowngrade, headingBackspace } from "./markdown/headingBackspace";
import { mermaidPreviewToggleText, renderMermaidPreview } from "./markdown/mermaid";
import { slashShortcutInputRule, slashShortcutKeys } from "./markdown/slashShortcuts";
import { anchorLinkPlugin } from "./markdown/anchors";
import { headingLinkPlugin } from "./markdown/headingLink";
import { wikiLinkPlugin, type LinkClick } from "./markdown/wikiLinks";
import { tableContextMenu } from "./markdown/tableMenu";
import { tableFullWidthPlugins } from "./markdown/tableFullWidth";
import { addTocMenuItem, tocPlugins } from "./markdown/toc";
import { tableLayoutPlugin } from "./markdown/tableLayout";
import { configureListDelimiter, listStylePlugins } from "./markdown/listStyles";
import { imageBlockAltSchema, tightListJoin } from "./markdown/gfmFidelity";
import { htmlViewPlugin, inlineHtmlPlugin } from "./markdown/htmlView";
import { vscodeCodeTheme } from "./codeTheme";

export interface EditorOptions {
  root: HTMLElement;
  markdown: string;
  /** A link was clicked: follow it and say whether it was followed. */
  onLink?: (link: LinkClick) => boolean;
  /** Storage for pasted/dropped files; Crepe's blob: uploader otherwise. */
  uploader?: Uploader;
  /** The image block's own Upload button. */
  onUpload?: (file: File) => Promise<string>;
  /** Display URL for an image src (document-relative paths need one). */
  proxyDomURL?: (src: string) => string | Promise<string>;
}

/**
 * Replace the current block with `blockquote(paragraph)`. Crepe's stock Quote
 * item wraps instead, which silently does nothing when no wrapping fits.
 */
function insertQuote(ctx: Ctx) {
  const editorView = ctx.get(editorViewCtx);
  const { state } = editorView;
  const pos = state.selection.$from;
  const node = blockquoteSchema.type(ctx).createAndFill(null, paragraphSchema.type(ctx).create());
  if (!node) return;
  const start = pos.before(pos.depth);
  const tr = state.tr.replaceWith(start, pos.after(pos.depth), node);
  tr.setSelection(TextSelection.near(tr.doc.resolve(start + 2)));
  editorView.dispatch(tr.scrollIntoView());
  editorView.focus();
}

/** A configured, not yet created, editor: call `create()` on it. */
export function buildEditor(options: EditorOptions): Crepe {
  const crepe = new Crepe({
    root: options.root,
    defaultValue: options.markdown,
    features: {
      // `$…$` (two dollar amounts in a sentence) stays literal text.
      [Crepe.Feature.Latex]: false,
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
      [Crepe.Feature.BlockEdit]: {
        listGroup: { taskList: { label: "Checklist" } },
        buildMenu: (builder) => {
          const quote = builder
            .build()
            .find((group) => group.key === "text")
            ?.items.find((item) => item.key === "quote");
          if (quote) quote.onRun = insertQuote;
          addTocMenuItem(builder);
          addGithubAlertMenuGroup(builder);
        },
      },
      // Covers inline images too: Crepe hands the same config to both.
      [Crepe.Feature.ImageBlock]: {
        ...(options.onUpload ? { onUpload: options.onUpload } : {}),
        ...(options.proxyDomURL ? { proxyDomURL: options.proxyDomURL } : {}),
      },
    },
  });
  // After construction: Crepe installs its own uploader in its constructor.
  const uploader = options.uploader;
  if (uploader) {
    crepe.editor.config((ctx) => {
      ctx.update(uploadConfig.key, (prev) => ({ ...prev, uploader }));
    });
  }
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
  // Raw HTML renders as GitHub shows it, and is editable as source.
  crepe.editor.use(htmlViewPlugin(options.proxyDomURL));
  crepe.editor.use(inlineHtmlPlugin);
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
