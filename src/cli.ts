#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildRepoModel } from "./build.js";
import { renderMarkdownReport } from "./report.js";

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

  const model = buildRepoModel(repoPath);
  const report = renderMarkdownReport(model);

  const outputPath = resolve(repoPath, "springlens-report.md");
  writeFileSync(outputPath, report, "utf-8");

  console.log(`Found ${model.classes.length} Spring-annotated classes.`);
  console.log(`Report written to: ${outputPath}`);
  console.log(
    "Dependency-risk analysis and codebase Q&A are coming in upcoming sprints."
  );
}

main(process.argv.slice(2));
