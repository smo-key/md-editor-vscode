/**
 * Which editor VS Code opens a file with by default, per the user's
 * `workbench.editorAssociations` (pure, so vitest covers it).
 */

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") i++;
        re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${glob
          .slice(i + 1, end)
          .split(",")
          .map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
          .join("|")})`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

/**
 * Whether `viewType` opens `path` by default: the most specific matching
 * association decides (patterns with a `/` match the whole path, others the
 * file name); with none, `fallback` (the editor's own priority).
 */
export function isDefaultEditor(path: string, viewType: string, associations: unknown, fallback: boolean): boolean {
  if (!associations || typeof associations !== "object") return fallback;
  const name = path.slice(path.lastIndexOf("/") + 1);
  let best: { length: number; ours: boolean } | null = null;
  for (const [pattern, type] of Object.entries(associations as Record<string, unknown>)) {
    if (typeof type !== "string") continue;
    const target = pattern.includes("/") ? path : name;
    if (!globToRegExp(pattern).test(target)) continue;
    if (!best || pattern.length > best.length) best = { length: pattern.length, ours: type === viewType };
  }
  return best ? best.ours : fallback;
}
