import path from "path";
import fs from "fs";

export function resolveSafe(root: string, rel: string): string {
  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, rel);
  if (abs !== absRoot && !abs.startsWith(absRoot + path.sep)) {
    throw new Error(`Path escapes workspace: ${rel}`);
  }
  return abs;
}

export function assertRootExists(root: string): void {
  const st = fs.existsSync(root) && fs.statSync(root);
  if (!st || !st.isDirectory()) throw new Error(`Workspace root is not a directory: ${root}`);
}
