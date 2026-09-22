import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { findJavaFiles } from "./scanner.js";
import { parseJavaFile } from "./parser.js";
import { ClassInfo, Dependency, RepoModel } from "./model.js";
import { assessDependencies, parseGradleDependencies, parsePomDependencies } from "./depscan.js";

function loadDependencies(rootPath: string): Dependency[] {
  const pomPath = resolve(rootPath, "pom.xml");
  if (existsSync(pomPath)) {
    return parsePomDependencies(readFileSync(pomPath, "utf-8"));
  }

  for (const gradleFile of ["build.gradle", "build.gradle.kts"]) {
    const gradlePath = resolve(rootPath, gradleFile);
    if (existsSync(gradlePath)) {
      return parseGradleDependencies(readFileSync(gradlePath, "utf-8"));
    }
  }

  return [];
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
    const relPath = relative(rootPath, file);
    const classesInFile = parseJavaFile(source, relPath);
    allClasses.push(...classesInFile);
  }

  const knownClassNames = new Set(allClasses.map((c) => c.name));

  for (const cls of allClasses) {
    cls.dependsOn = cls.dependsOn.filter((dep) => knownClassNames.has(dep));
  }

  const dependencies = loadDependencies(rootPath);
  const riskFindings = assessDependencies(dependencies);

  return { rootPath, classes: allClasses, dependencies, riskFindings };
}
