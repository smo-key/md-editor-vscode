/**
 * Typography settings (`kenMarkdown.*` fonts, sizes, spacing, width) as CSS
 * variables on the page. Shared by the editor and the diff view.
 */
import type { EditorConfig } from "../src/protocol";
import { tabSizeValue } from "../src/tabSize";

export function applyTypography(config: EditorConfig): void {
  const root = document.documentElement.style;
  // An empty setting falls back to the stylesheet's default (the bundled fonts).
  const font = (prop: string, value: string) => (value.trim() ? root.setProperty(prop, value) : root.removeProperty(prop));
  font("--font-sans", config.bodyFontFamily ?? "");
  font("--font-serif", config.headingFontFamily ?? "");
  font("--font-mono", config.codeFontFamily ?? "");
  font("--font-quote", config.quoteFontFamily ?? "");
  root.setProperty("--md-font-size", `${config.fontSize}px`);
  root.setProperty("--md-line-height", String(config.lineHeight));
  if (typeof config.paragraphSpacing === "number") root.setProperty("--md-paragraph-spacing", `${config.paragraphSpacing}em`);
  else root.removeProperty("--md-paragraph-spacing");
  if (typeof config.headingSpacingBefore === "number") root.setProperty("--md-heading-spacing-before", `${config.headingSpacingBefore}em`);
  else root.removeProperty("--md-heading-spacing-before");
  if (typeof config.headingSpacingAfter === "number") root.setProperty("--md-heading-spacing-after", `${config.headingSpacingAfter}em`);
  else root.removeProperty("--md-heading-spacing-after");
  root.setProperty("--md-max-width", `${config.maxWidth}px`);
  // Tabs typed in paragraphs (markdown/plainTab.ts) are editor.tabSize wide.
  root.setProperty("--md-tab-size", String(tabSizeValue(config.tabSize)));
}
