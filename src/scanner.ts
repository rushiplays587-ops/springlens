import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const EXCLUDED_DIRS = new Set([
  "target",
  "build",
  "node_modules",
  ".git",
  "out",
  "bin",
]);

/**
 * Recursively finds all .java files under rootPath, skipping build output
 * and VCS directories so we only scan actual source.
 */
export function findJavaFiles(rootPath: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable directory (permissions, symlink loop, etc.) — skip it
    }

    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry)) continue;

      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile() && entry.endsWith(".java")) {
        results.push(fullPath);
      }
    }
  }

  walk(rootPath);
  return results;
}
