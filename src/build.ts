import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { findJavaFiles } from "./scanner.js";
import { parseJavaFile } from "./parser.js";
import { ClassInfo, Dependency, RepoModel } from "./model.js";
import {
  assessDependencies,
  parseGradleDependencies,
  parentRelativePath,
  parsePomContext,
  parsePomDependencies,
  parsePomModules,
  PomContext,
} from "./depscan.js";

const MAX_MODULE_DEPTH = 10;

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

/** The parent pom a pom points at via <parent>/<relativePath>, if it is a readable pom inside the repo. */
function findParentPom(rootPath: string, pomPath: string, xml: string): string | null {
  const rel = parentRelativePath(xml);
  if (rel === null) return null;
  let candidate = resolve(dirname(pomPath), rel);
  try {
    if (statSync(candidate).isDirectory()) candidate = resolve(candidate, "pom.xml");
  } catch {
    return null;
  }
  if (candidate === pomPath || relative(rootPath, candidate).startsWith("..") || !existsSync(candidate)) {
    return null;
  }
  return candidate;
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
    // Maven inheritance follows each pom's <parent> (default ../pom.xml), not the <modules> list, so a
    // module can inherit from a sibling "parent" module. Only parents inside the scanned repo are read.
    const contexts = new Map<string, { own: PomContext; inherited?: PomContext }>();
    const contextOf = (pom: string, guard: Set<string>): { own: PomContext; inherited?: PomContext } => {
      const known = contexts.get(pom);
      if (known) return known;
      const xml = readFileSync(pom, "utf-8");
      let inherited: PomContext | undefined;
      const parentPom = guard.has(pom) ? undefined : findParentPom(rootPath, pom, xml);
      if (parentPom) inherited = contextOf(parentPom, new Set(guard).add(pom)).own;
      const result = { own: parsePomContext(xml, inherited), inherited };
      contexts.set(pom, result);
      return result;
    };
    for (const pom of poms) {
      buildFiles.push(relative(rootPath, pom).split(sep).join("/"));
      addAll(parsePomDependencies(readFileSync(pom, "utf-8"), contextOf(pom, new Set()).inherited));
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
