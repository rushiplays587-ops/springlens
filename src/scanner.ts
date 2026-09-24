import { lstatSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

// Never source, anywhere in the tree.
const ALWAYS_EXCLUDED_DIRS = new Set(["node_modules", ".git"]);

// Build-output names at a project root, but also legitimate Java package
// names (com.acme.build, com.acme.target) once we are inside a src/ tree.
const BUILD_OUTPUT_DIRS = new Set(["target", "build", "out", "bin"]);

/**
 * Recursively finds all .java files under rootPath, skipping build output
 * and VCS directories and src/test so we only scan production source. Symbolic links are not
 * followed (avoids loops and escaping the scanned tree).
 */
export function findJavaFiles(rootPath: string): string[] {
  return findFiles(rootPath, (name) => name.endsWith(".java"));
}

/** Same walk and exclusions as findJavaFiles, for any file name the predicate accepts (e.g. application.yml). */
export function findFiles(rootPath: string, accept: (fileName: string) => boolean): string[] {
  const results: string[] = [];

  function walk(dir: string, srcDepth: number): void {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return; // unreadable directory (permissions etc.) — skip it
    }

    for (const entry of entries) {
      if (ALWAYS_EXCLUDED_DIRS.has(entry)) continue;

      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;

      if (stat.isDirectory()) {
        // Maven/Gradle test sources (src/test): test-only @Configuration/@Component classes
        // are not part of the application's architecture. Only the outermost src counts, so a
        // package named src.test (or a package named test) inside src/main is still scanned.
        if (entry === "test" && dir !== rootPath && basename(dir) === "src" && srcDepth === 1) continue;
        if (srcDepth === 0 && BUILD_OUTPUT_DIRS.has(entry)) continue;
        walk(fullPath, srcDepth + (entry === "src" ? 1 : 0));
      } else if (stat.isFile() && accept(entry)) {
        results.push(fullPath);
      }
    }
  }

  walk(rootPath, 0);
  return results;
}
