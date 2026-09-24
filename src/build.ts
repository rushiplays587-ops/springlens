import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { findFiles, findJavaFiles } from "./scanner.js";
import { MAX_CONFIG_FILE_BYTES, bindClassConfig, isConfigFileName, parseConfigFile } from "./config.js";
import { parseJavaFile } from "./parser.js";
import { ClassInfo, ConfigFile, Dependency, RepoModel } from "./model.js";
import {
  assessDependencies,
  parseGradleDependencies,
  parentCoordinates,
  parentRelativePath,
  parsePomContext,
  parsePomDependencies,
  parsePomModules,
  pomCoordinates,
  PomContext,
} from "./depscan.js";

const MAX_MODULE_DEPTH = 10;

/** True if p is rootPath or below it. Also correct across Windows drives, where relative() returns an absolute path. */
function isInside(rootPath: string, p: string): boolean {
  const rel = relative(rootPath, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Collects a pom and, recursively, the poms of the modules it declares (kept inside rootPath).
 * A pom reached again by a shorter route is re-walked, so which modules are collected does not
 * depend on the order they are listed in.
 */
function collectPoms(
  rootPath: string,
  pomPath: string,
  seen: Map<string, number>,
  depth: number
): void {
  const previous = seen.get(pomPath);
  if ((previous !== undefined && previous <= depth) || depth > MAX_MODULE_DEPTH || !isFile(pomPath)) return;
  seen.set(pomPath, depth);

  let xml: string;
  try {
    xml = readFileSync(pomPath, "utf-8");
  } catch {
    return; // unreadable pom — skip it rather than fail the whole scan
  }
  const moduleBase = resolve(pomPath, "..");
  for (const moduleName of parsePomModules(xml)) {
    // A <module> may name a directory or the pom file itself (sub/pom.xml, sub/other-pom.xml).
    const target = resolve(moduleBase, moduleName);
    const modulePom = /\.xml$/i.test(moduleName) ? target : resolve(target, "pom.xml");
    if (!isInside(rootPath, modulePom)) continue; // never follow a <module> out of the scanned repo
    collectPoms(rootPath, modulePom, seen, depth + 1);
  }
}

/**
 * The parent pom a pom points at via <parent>/<relativePath>, if it is a readable pom inside the repo.
 * Like Maven, a pom found at the relative path only counts if its groupId and artifactId are the ones
 * the <parent> element declares; otherwise the real parent lives in a repository we cannot read (for
 * example spring-boot-starter-parent next to an unrelated aggregator pom).
 */
function findParentPom(rootPath: string, pomPath: string, xml: string): string | null {
  const rel = parentRelativePath(xml);
  if (rel === null) return null;
  let candidate = resolve(dirname(pomPath), rel);
  try {
    if (statSync(candidate).isDirectory()) candidate = resolve(candidate, "pom.xml");
  } catch {
    return null;
  }
  if (candidate === pomPath || !isInside(rootPath, candidate) || !isFile(candidate)) return null;

  const declared = parentCoordinates(xml);
  let actual: { groupId?: string; artifactId?: string };
  try {
    actual = pomCoordinates(readFileSync(candidate, "utf-8"));
  } catch {
    return null;
  }
  if (declared?.artifactId !== actual.artifactId || declared?.groupId !== actual.groupId) return null;
  return candidate;
}

/** Pom text, or "" if it cannot be read (an empty pom contributes nothing). */
function readPom(pom: string): string {
  try {
    return readFileSync(pom, "utf-8");
  } catch {
    return "";
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
  if (isFile(rootPom)) {
    const found = new Map<string, number>();
    collectPoms(rootPath, rootPom, found, 0);
    const poms = new Set(found.keys());
    // Maven inheritance follows each pom's <parent> (default ../pom.xml), not the <modules> list, so a
    // module can inherit from a sibling "parent" module. Only parents inside the scanned repo are read.
    // A parent's own <dependencies> are inherited by its children, so parents reached this way are
    // scanned too (the Set keeps growing while we iterate it).
    for (const pom of poms) {
      const parent = findParentPom(rootPath, pom, readPom(pom));
      if (parent) poms.add(parent);
    }

    type Context = { own: PomContext; inherited?: PomContext; truncated: boolean };
    const contexts = new Map<string, Context>();
    const contextOf = (pom: string, guard: Set<string>): Context => {
      const known = contexts.get(pom);
      if (known) return known;
      const xml = readPom(pom);
      let inherited: PomContext | undefined;
      let truncated = guard.has(pom);
      const parentPom = truncated ? null : findParentPom(rootPath, pom, xml);
      if (parentPom) {
        const parentContext = contextOf(parentPom, new Set(guard).add(pom));
        inherited = parentContext.own;
        truncated = parentContext.truncated;
      }
      const result = { own: parsePomContext(xml, inherited), inherited, truncated };
      // A context cut short by a parent cycle depends on where the walk started, so it is not reusable.
      if (!truncated) contexts.set(pom, result);
      return result;
    };
    for (const pom of poms) {
      buildFiles.push(relative(rootPath, pom).split(sep).join("/"));
      addAll(parsePomDependencies(readPom(pom), contextOf(pom, new Set()).inherited));
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

/** Reads the application and bootstrap config files; one that cannot be read or parsed becomes an entry with `error` set. */
function loadConfigs(rootPath: string): ConfigFile[] {
  return findFiles(rootPath, isConfigFileName).map((file) => {
    const rel = relative(rootPath, file).split(sep).join("/");
    try {
      if (statSync(file).size > MAX_CONFIG_FILE_BYTES) {
        return parseConfigFile(rel, "x".repeat(MAX_CONFIG_FILE_BYTES + 1)); // reuses the size-cap message without reading the file
      }
      return parseConfigFile(rel, readFileSync(file, "utf-8"));
    } catch (err) {
      return { ...parseConfigFile(rel, ""), error: `unreadable (${(err as Error).message.split("\n")[0]})` };
    }
  });
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

  bindClassConfig(allClasses);
  const configs = loadConfigs(rootPath);

  return { rootPath, classes: allClasses, dependencies, buildFiles, riskFindings, configs };
}
