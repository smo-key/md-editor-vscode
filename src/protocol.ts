/** Messages between the extension host and the editor webview. */

export interface EditorConfig {
  fontSize: number;
  bodyFontFamily: string;
  headingFontFamily: string;
  codeFontFamily: string;
  lineHeight: number;
  maxWidth: number;
  toolbar: boolean;
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
  | { type: "init"; text: string; config: EditorConfig; docPath: string }
  | { type: "update"; text: string }
  | { type: "config"; config: EditorConfig }
  | { type: "attachmentSaved"; id: number; path?: string; error?: string }
  | { type: "resolved"; id: number; url?: string }
  | { type: "linkedUris"; id: number; items: LinkedUri[] }
  | { type: "flush"; id: number }
  | { type: "test"; id: number; action: TestAction };

export type TestAction =
  | { kind: "getMarkdown" }
  | { kind: "insertText"; text: string; at: "start" | "end" | "caret" }
  | { kind: "getStyle"; selector: string; property: string }
  | { kind: "count"; selector: string }
  | { kind: "getAttr"; selector: string; name: string }
  | { kind: "click"; selector: string }
  | {
      kind: "transfer";
      event: "paste" | "drop";
      files?: { name: string; type: string; base64: string }[];
      uris?: string[];
      /** Drop in the margin below the text instead of at the caret. */
      margin?: boolean;
    }
  | { kind: "images" }
  | { kind: "caretAfter"; text: string }
  | { kind: "undo" }
  | { kind: "key"; key: string; code: string; meta?: boolean; ctrl?: boolean; shift?: boolean };

export type WebviewMessage =
  | { type: "ready" }
  | { type: "edit"; text: string }
  | { type: "saveAttachment"; id: number; name: string; data: Uint8Array; image: boolean }
  | { type: "resolve"; id: number; path: string }
  | { type: "linkUris"; id: number; uris: string[] }
  | { type: "openLink"; href: string }
  | { type: "openWikiLink"; target: string }
  | { type: "flushed"; id: number; text: string | null }
  | { type: "testResult"; id: number; result: unknown }
  | { type: "error"; message: string };
