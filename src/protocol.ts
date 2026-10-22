/** Messages between the extension host and the editor webview. */

export type ToolbarPosition = "top" | "bottom" | "hidden";

export interface EditorConfig {
  fontSize: number;
  bodyFontFamily: string;
  headingFontFamily: string;
  codeFontFamily: string;
  quoteFontFamily: string;
  lineHeight: number;
  maxWidth: number;
  toolbar: ToolbarPosition;
  alwaysShowProperties: boolean;
  /** Name shown on new comments. */
  commentAuthor: string;
}

/** A file dropped from VS Code's Explorer, as the document should reference it. */
export interface LinkedUri {
  /** Path relative to the document (unencoded), or the URI when not relative. */
  path: string;
  relative: boolean;
  /** File name, for link text. */
  name: string;
}

export type HostMessage =
  | { type: "init"; text: string; config: EditorConfig; docPath: string; shortcuts: ShortcutLabels; prefs: EditorPrefs }
  /** Run an editor command (webview/commands.ts id), from a VS Code keybinding or the palette. */
  | { type: "command"; id: string }
  | { type: "shortcuts"; labels: ShortcutLabels }
  | { type: "showShortcuts" }
  | { type: "update"; text: string }
  | { type: "config"; config: EditorConfig }
  | { type: "attachmentSaved"; id: number; path?: string; error?: string }
  | { type: "resolved"; id: number; url?: string }
  | { type: "linkedUris"; id: number; items: LinkedUri[] }
  | { type: "fileRead"; id: number; data?: Uint8Array; error?: string }
  | { type: "fileWritten"; id: number; error?: string }
  | { type: "diagramCreated"; id: number; path?: string; error?: string }
  | { type: "flush"; id: number }
  | { type: "test"; id: number; action: TestAction };

export type TestAction =
  | { kind: "getMarkdown" }
  | { kind: "insertText"; text: string; at: "start" | "end" | "caret" }
  | { kind: "getStyle"; selector: string; property: string }
  | { kind: "count"; selector: string }
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
  | { kind: "key"; key: string; code: string; meta?: boolean; ctrl?: boolean; shift?: boolean };

/** Choices the editor remembers across editors and sessions. */
export interface EditorPrefs {
  /** Heading level the toolbar's heading button applies outside headings. */
  lastHeading?: number;
}

/** Effective key label per editor command id (and "kenMarkdown.showShortcuts"); "" when unbound. */
export type ShortcutLabels = Record<string, string>;

export type WebviewMessage =
  | { type: "ready" }
  | { type: "focus"; focused: boolean }
  | { type: "setPrefs"; prefs: EditorPrefs }
  | { type: "openKeybindings" }
  | { type: "edit"; text: string }
  | { type: "saveAttachment"; id: number; name: string; data: Uint8Array; image: boolean }
  | { type: "resolve"; id: number; path: string }
  | { type: "linkUris"; id: number; uris: string[] }
  /** Root-relative paths, as in `resolve`. */
  | { type: "readFile"; id: number; path: string }
  | { type: "writeFile"; id: number; path: string; data: Uint8Array }
  | { type: "createDiagram"; id: number }
  | { type: "openFile"; path: string }
  | { type: "openLink"; href: string }
  | { type: "openWikiLink"; target: string }
  | { type: "flushed"; id: number; text: string | null }
  | { type: "testResult"; id: number; result: unknown }
  | { type: "error"; message: string };
