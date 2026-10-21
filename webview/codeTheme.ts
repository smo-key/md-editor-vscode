/**
 * CodeMirror (code blocks) themed by the active VS Code theme. Crepe would
 * otherwise use One Dark everywhere. VS Code does not expose its syntax token
 * colours to webviews, so the highlight style borrows the closest theme
 * colours it does expose (debug token expressions, symbol icons), which every
 * theme defines and which track its palette.
 */
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const v = (name: string, fallback = "inherit") => `var(--vscode-${name}, ${fallback})`;

const editorTheme = EditorView.theme({
  "&": {
    color: v("editor-foreground"),
    backgroundColor: "transparent",
    fontFamily: "var(--font-mono)",
  },
  ".cm-scroller": { fontFamily: "var(--font-mono)" },
  ".cm-content": { caretColor: v("editorCursor-foreground") },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: v("editorCursor-foreground") },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: v("editor-selectionBackground") },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: v("editorLineNumber-foreground"),
    border: "none",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: v("editorLineNumber-activeForeground"),
  },
  ".cm-activeLine": { backgroundColor: "transparent" },
  "&.cm-focused .cm-activeLine": { backgroundColor: v("editor-lineHighlightBackground", "transparent") },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: v("editorBracketMatch-background", "transparent"),
    outline: `1px solid ${v("editorBracketMatch-border", "transparent")}`,
  },
  ".cm-searchMatch": { backgroundColor: v("editor-findMatchHighlightBackground") },
  ".cm-foldPlaceholder": {
    backgroundColor: v("editorWidget-background"),
    border: "none",
    color: v("descriptionForeground"),
  },
  ".cm-tooltip": {
    backgroundColor: v("editorHoverWidget-background"),
    color: v("editorHoverWidget-foreground"),
    border: `1px solid ${v("editorHoverWidget-border", "transparent")}`,
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: v("list-activeSelectionBackground"),
    color: v("list-activeSelectionForeground"),
  },
});

// The debug-token colours are the theme's own keyword/string/number colours
// in the default themes (blue keywords, purple control flow, and so on).
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier, t.self, t.bool, t.null],
    color: v("debugTokenExpression-boolean") },
  { tag: t.controlKeyword, color: v("debugTokenExpression-name") },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: v("debugTokenExpression-string") },
  { tag: [t.number, t.atom, t.unit], color: v("debugTokenExpression-number") },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: v("descriptionForeground"), fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))],
    color: v("symbolIcon-functionForeground") },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: v("symbolIcon-classForeground") },
  { tag: [t.variableName, t.definition(t.variableName), t.propertyName, t.attributeName, t.labelName],
    color: v("symbolIcon-variableForeground") },
  { tag: [t.tagName, t.heading], color: v("debugTokenExpression-boolean"), fontWeight: "bold" },
  { tag: [t.meta, t.processingInstruction], color: v("descriptionForeground") },
  { tag: t.invalid, color: v("errorForeground") },
  { tag: t.link, color: v("textLink-foreground"), textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.strikethrough, textDecoration: "line-through" },
]);

export const vscodeCodeTheme = [editorTheme, syntaxHighlighting(highlight)];
