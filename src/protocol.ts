/** Messages between the extension host and the editor webview. */

import type { HeadingNumbersConfig } from "./headingNumbers";
import type { LucidPreviewMode } from "./lucidUrl";

export type { HeadingNumbersConfig, LucidPreviewMode };

export type ToolbarPosition = "top" | "bottom" | "hidden";

export interface EditorConfig {
  fontSize: number;
  bodyFontFamily: string;
  headingFontFamily: string;
  codeFontFamily: string;
  quoteFontFamily: string;
  lineHeight: number;
  /** Gap between paragraphs, in em. */
  paragraphSpacing: number;
  /** Space above / below a body-size heading, in em; larger headings scale it. */
  headingSpacingBefore: number;
  headingSpacingAfter: number;
  maxWidth: number;
  toolbar: ToolbarPosition;
  alwaysShowProperties: boolean;
  /** Name shown on new comments. */
  commentAuthor: string;
  /**
   * Lucidchart/Lucidspark link previews (`kenMarkdown.lucidchart.*`). The host
   * always sends it; the webview treats a missing value (old harness configs)
   * as `{ preview: "auto" }`.
   */
  lucidchart: LucidchartConfig;
  /**
   * Heading numbers (`kenMarkdown.headingNumbers.*`), display only. The host always
   * sends it; the webview treats a missing value (old harness configs) as off.
   */
  headingNumbers: HeadingNumbersConfig;
  /**
   * Width of a tab character, in columns: the document's effective
   * `editor.tabSize` (`[markdown]` overrides included). The host always sends
   * it; the webview treats a missing value (old harness configs) as 4.
   */
  tabSize: number;
}

export interface LucidchartConfig {
  preview: LucidPreviewMode;
}

/**
 * A file dropped from VS Code's Explorer, as the document should reference it:
 * linked where it is when in the document's workspace folder, else a copy.
 */
export interface LinkedUri {
  /** Path relative to the document (unencoded), or the URI when not relative. */
  path: string;
  relative: boolean;
  /** File name, for link text. */
  name: string;
}

export type HostMessage =
  | {
      type: "init";
      text: string;
      config: EditorConfig;
      docPath: string;
      shortcuts: ShortcutLabels;
      /** Effective keys per editor command id, which the page claims (keys.ts). */
      keys?: ShortcutKeys;
      prefs: EditorPrefs;
    }
  /** Run an editor command (webview/commands.ts id), from a VS Code keybinding or the palette. */
  | { type: "command"; id: string }
  | { type: "shortcuts"; labels: ShortcutLabels; keys?: ShortcutKeys }
  | { type: "showShortcuts" }
  | { type: "update"; text: string }
  | { type: "config"; config: EditorConfig }
  | { type: "attachmentSaved"; id: number; path?: string; error?: string }
  | { type: "resolved"; id: number; url?: string }
  | { type: "linkedUris"; id: number; items: LinkedUri[] }
  | { type: "fileRead"; id: number; data?: Uint8Array; error?: string }
  | { type: "fileWritten"; id: number; error?: string }
  | { type: "diagramCreated"; id: number; path?: string; error?: string }
  /** The clipboard's text, for Paste as Plain Text. */
  | { type: "clipboardText"; id: number; text: string }
  | { type: "flush"; id: number }
  /** A collaboration session began for this editor (collab.ts): `seed` fills the empty shared document. */
  | { type: "collabStart"; seed: boolean; state: Uint8Array; awareness: Uint8Array; name: string }
  | { type: "collabUpdate"; data: Uint8Array }
  | { type: "collabAwareness"; data: Uint8Array }
  /** Whether this editor writes the shared document to its file. */
  | { type: "collabWriter"; writer: boolean }
  | { type: "collabStop" }
  | { type: "test"; id: number; action: TestAction };

export type TestAction =
  | { kind: "getMarkdown" }
  | { kind: "insertText"; text: string; at: "start" | "end" | "caret" }
  | { kind: "getStyle"; selector: string; property: string }
  | { kind: "count"; selector: string }
  /** The text content of the first element matching `selector`, or null. */
  | { kind: "getText"; selector: string }
  | { kind: "getAttr"; selector: string; name: string }
  | { kind: "click"; selector: string }
  | { kind: "fill"; selector: string; value: string }
  | {
      kind: "transfer";
      event: "paste" | "drop";
      files?: { name: string; type: string; base64: string }[];
      uris?: string[];
      /** Drop in the margin below the text instead of at the caret. */
      margin?: boolean;
    }
  | { kind: "images" }
  | { kind: "selectText"; text: string }
  | { kind: "caretAfter"; text: string }
  | { kind: "undo" }
  /** Collaboration state: whether shared, writing, and who else is here. */
  | { kind: "collab" }
  | { kind: "key"; key: string; code: string; meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean };

/** Choices the editor remembers across editors and sessions. */
export interface EditorPrefs {
  /** Heading level the toolbar's heading button applies outside headings. */
  lastHeading?: number;
}

/** Effective key label per editor command id (and "kenMarkdown.showShortcuts"); "" when unbound. */
export type ShortcutLabels = Record<string, string>;

/** Effective keys per editor command id, in VS Code notation (e.g. "alt+up"). */
export type ShortcutKeys = Record<string, string[]>;

export type WebviewMessage =
  | { type: "ready" }
  | { type: "focus"; focused: boolean }
  | { type: "setPrefs"; prefs: EditorPrefs }
  | { type: "openKeybindings" }
  | { type: "edit"; text: string }
  /**
   * Save a pasted or dropped file as `name`. `sourceName` is the file's own name
   * when it came from a file (not raw image bytes): an identical file of that
   * name already in the workspace is linked instead (`kenMarkdown.workspaceFiles`).
   */
  | { type: "saveAttachment"; id: number; name: string; data: Uint8Array; image: boolean; sourceName?: string }
  | { type: "resolve"; id: number; path: string }
  | { type: "linkUris"; id: number; uris: string[] }
  /** Root-relative paths, as in `resolve`. */
  | { type: "readFile"; id: number; path: string }
  | { type: "writeFile"; id: number; path: string; data: Uint8Array }
  | { type: "createDiagram"; id: number }
  /** Read the clipboard's text (a webview can't read it itself). */
  | { type: "readClipboard"; id: number }
  /** Open this standalone page of the document in the browser, to print it. */
  | { type: "print"; html: string; name: string }
  | { type: "openFile"; path: string }
  | { type: "openLink"; href: string }
  | { type: "openWikiLink"; target: string }
  /**
   * Open a Lucid link in the browser: `edit` opens the document's edit URL,
   * `open` the link as written. The host re-parses `url` (src/lucidUrl.ts)
   * and ignores anything that isn't an allowlisted Lucid URL.
   */
  | { type: "openLucid"; url: string; action: "edit" | "open" }
  | { type: "flushed"; id: number; text: string | null }
  | { type: "collabUpdate"; data: Uint8Array }
  | { type: "collabAwareness"; data: Uint8Array }
  /** The editor left the session; a non-writer wants the file's text back. */
  | { type: "collabStopped"; writer: boolean }
  | { type: "testResult"; id: number; result: unknown }
  | { type: "error"; message: string };

// --- The diff view (src/diffPanel.ts ↔ webview/diff.ts) -----------------------------

export type DiffLayoutMode = "combined" | "split";

export interface DiffContent {
  /** The earlier version (e.g. HEAD), "" when the file is new. */
  oldText: string;
  newText: string;
  /** Labels for the two versions, e.g. "HEAD" and "Working Tree". */
  oldLabel: string;
  newLabel: string;
}

export type DiffHostMessage =
  | ({ type: "diffInit"; config: EditorConfig; layout: DiffLayoutMode; base: string } & DiffContent)
  | ({ type: "diffUpdate" } & DiffContent)
  | { type: "config"; config: EditorConfig };

export type DiffWebviewMessage =
  | { type: "diffReady" }
  | { type: "diffLayout"; layout: DiffLayoutMode }
  | { type: "openFile" }
  | { type: "error"; message: string };
