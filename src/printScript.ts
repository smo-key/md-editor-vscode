/** The script a print page ends with: the print dialog, once fonts and images are in. Pure; shared by webview/print.ts and the export. */
export const AUTO_PRINT_SCRIPT = `<script>
  // Fonts and images first, then the print dialog.
  window.addEventListener("load", () => {
    (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => setTimeout(() => window.print(), 300));
  });
</script>`;

/** `html` (an exported page) that brings up the print dialog when opened. */
export function withAutoPrint(html: string): string {
  return html.includes(AUTO_PRINT_SCRIPT) ? html : html.replace(/<\/body>\s*<\/html>\s*$/, `${AUTO_PRINT_SCRIPT}\n</body>\n</html>`);
}
