/** Messages between the extension host and the editor webview. */

export interface EditorConfig {
  fontSize: number;
  bodyFontFamily: string;
  headingFontFamily: string;
  codeFontFamily: string;
  lineHeight: number;
  maxWidth: number;
}

export type HostMessage =
  | { type: "init"; text: string; config: EditorConfig; docPath: string }
  | { type: "update"; text: string }
  | { type: "config"; config: EditorConfig }
  | { type: "attachmentSaved"; id: number; path?: string; error?: string }
  | { type: "resolved"; id: number; url?: string }
  | { type: "flush"; id: number }
  | { type: "test"; id: number; action: TestAction };

export type TestAction =
  | { kind: "getMarkdown" }
  | { kind: "insertText"; text: string; at: "start" | "end" }
  | { kind: "getStyle"; selector: string; property: string }
  | { kind: "count"; selector: string }
  | { kind: "getAttr"; selector: string; name: string }
  | { kind: "undo" }
  | { kind: "key"; key: string; code: string; meta?: boolean; ctrl?: boolean; shift?: boolean };

export type WebviewMessage =
  | { type: "ready" }
  | { type: "edit"; text: string }
  | { type: "saveAttachment"; id: number; name: string; data: Uint8Array }
  | { type: "resolve"; id: number; path: string }
  | { type: "openLink"; href: string }
  | { type: "openWikiLink"; target: string }
  | { type: "flushed"; id: number; text: string | null }
  | { type: "testResult"; id: number; result: unknown }
  | { type: "error"; message: string };
