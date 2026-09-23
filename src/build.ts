import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { findJavaFiles } from "./scanner.js";
import { parseJavaFile } from "./parser.js";
import { ClassInfo, Dependency, RepoModel } from "./model.js";
import {
  assessDependencies,
  parseGradleDependencies,
  parsePomDependencies,
  parsePomModules,
} from "./depscan.js";

const MAX_MODULE_DEPTH = 5;

/** Collects a pom and, recursively, the poms of the modules it declares (kept inside rootPath). */
function collectPoms(rootPath: string, pomPath: string, seen: Set<string>, depth: number): void {
  if (seen.has(pomPath) || depth > MAX_MODULE_DEPTH || !existsSync(pomPath)) return;
  seen.add(pomPath);

  const xml = readFileSync(pomPath, "utf-8");
  const moduleBase = resolve(pomPath, "..");
  for (const moduleName of parsePomModules(xml)) {
    const modulePom = resolve(moduleBase, moduleName, "pom.xml");
    const rel = relative(rootPath, modulePom);
    if (rel.startsWith("..")) continue; // never follow a <module> out of the scanned repo
    collectPoms(rootPath, modulePom, seen, depth + 1);
  }
}

function loadDependencies(rootPath: string): { dependencies: Dependency[]; buildFiles: string[] } {
  const buildFiles: string[] = [];
  const dependencies: Dependency[] = [];
  const seenDeps = new Set<string>();
  const addAll = (deps: Dependency[]) => {
    for (const d of deps) {
      const key = `${d.groupId}:${d.artifactId}:${d.version ?? ""}`;
      if (seenDeps.has(key)) continue;
      seenDeps.add(key);
      dependencies.push(d);
    }
  };

  const rootPom = resolve(rootPath, "pom.xml");
  if (existsSync(rootPom)) {
    const poms = new Set<string>();
    collectPoms(rootPath, rootPom, poms, 0);
    for (const pom of poms) {
      buildFiles.push(relative(rootPath, pom).split(sep).join("/"));
      addAll(parsePomDependencies(readFileSync(pom, "utf-8")));
    }
    return { dependencies, buildFiles };
  }

  for (const gradleFile of ["build.gradle", "build.gradle.kts"]) {
    const gradlePath = resolve(rootPath, gradleFile);
    if (existsSync(gradlePath)) {
      buildFiles.push(gradleFile);
      addAll(parseGradleDependencies(readFileSync(gradlePath, "utf-8")));
      break;
    }
  }

  return { dependencies, buildFiles };
}

/**
 * Scans every .java file under rootPath and builds the full repo model:
 * every Spring-annotated class found, with its dependencies filtered down
 * to only the names that resolve to another class actually present in this
 * repo (so a constructor param of a JDK/library type we didn't already know
 * to ignore doesn't show up as a dangling, unresolvable "dependency").
 */
export function buildRepoModel(rootPath: string): RepoModel {
  const files = findJavaFiles(rootPath);
  const allClasses: ClassInfo[] = [];

  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, "utf-8");
    } catch {
      continue; // unreadable file — skip rather than fail the whole scan
    }
    const relPath = relative(rootPath, file).split(sep).join("/");
    const classesInFile = parseJavaFile(source, relPath);
    allClasses.push(...classesInFile);
  }

  const knownClassNames = new Set(allClasses.map((c) => c.name));

  for (const cls of allClasses) {
    cls.dependsOn = cls.dependsOn.filter((dep) => knownClassNames.has(dep));
  }

  const { dependencies, buildFiles } = loadDependencies(rootPath);
  const riskFindings = assessDependencies(dependencies);

  return { rootPath, classes: allClasses, dependencies, buildFiles, riskFindings };
}
