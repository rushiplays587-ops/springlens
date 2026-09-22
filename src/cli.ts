#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const VERSION = "0.1.0";

function printUsage(): void {
  console.log(`SpringLens v${VERSION}
AI-powered onboarding and dependency-risk analysis for Java/Spring Boot codebases.

Usage:
  springlens <path-to-repo>

Example:
  springlens ./my-legacy-service
`);
}

function main(argv: string[]): void {
  const target = argv[0];

  if (!target || target === "--help" || target === "-h") {
    printUsage();
    return;
  }

  const repoPath = resolve(target);

  if (!existsSync(repoPath)) {
    console.error(`SpringLens: path not found — ${repoPath}`);
    process.exitCode = 1;
    return;
  }

  const looksLikeMavenOrGradle =
    existsSync(resolve(repoPath, "pom.xml")) ||
    existsSync(resolve(repoPath, "build.gradle")) ||
    existsSync(resolve(repoPath, "build.gradle.kts"));

  if (!looksLikeMavenOrGradle) {
    console.warn(
      `SpringLens: no pom.xml or build.gradle found at ${repoPath} — this may not be a Maven/Gradle Spring Boot project.`
    );
  }

  console.log(`SpringLens v${VERSION}`);
  console.log(`Scanning: ${repoPath}`);
  console.log(
    "Structural analysis (controllers/services/repositories/entities), dependency-risk report, " +
      "and codebase Q&A are coming in upcoming sprints — this is the v0.1 CLI skeleton."
  );
}

main(process.argv.slice(2));
