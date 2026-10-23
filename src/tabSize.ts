/**
 * How wide a tab character is drawn in the editor, from `editor.tabSize` (the
 * document's effective value, `[markdown]` overrides included). Pure, so both
 * bundles and the unit tests share it.
 */

export const DEFAULT_TAB_SIZE = 4;

/** A whole number of columns, 1–32; anything else is VS Code's default of 4. */
export function tabSizeValue(value: unknown): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_TAB_SIZE;
  const whole = Math.round(n);
  return whole >= 1 && whole <= 32 ? whole : DEFAULT_TAB_SIZE;
}
