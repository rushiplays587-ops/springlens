#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildRepoModel } from "./build.js";
import { renderMarkdownReport } from "./report.js";
import { narrateAll } from "./narrate.js";

const VERSION = "0.1.0";

function printUsage(): void {
  console.log(`SpringLens v${VERSION}
AI-powered onboarding and dependency-risk analysis for Java/Spring Boot codebases.

Usage:
  springlens <path-to-repo> [--no-ai]

Example:
  springlens ./my-legacy-service

AI narrative (plain-English explanations per class) requires an
ANTHROPIC_API_KEY environment variable. Without one, or with --no-ai,
SpringLens still produces the full structural report — just without the
narrative text.
`);
}

async function main(argv: string[]): Promise<void> {
  const noAi = argv.includes("--no-ai");
  const target = argv.find((a) => !a.startsWith("--"));

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
  console.log(`Found ${model.classes.length} Spring-annotated classes.`);
  console.log(
    `Scanned ${model.dependencies.length} dependencies — ${model.riskFindings.length} flagged.`
  );

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (noAi) {
    console.log("AI narrative skipped (--no-ai). Structural report only.");
  } else if (!apiKey) {
    console.log(
      "AI narrative skipped: no ANTHROPIC_API_KEY set. Structural report only " +
        "— set that env var (or drop --no-ai if you'd passed it) to get plain-English " +
        "explanations per class."
    );
  } else if (model.classes.length > 0) {
    console.log(`Generating AI narrative for ${model.classes.length} classes...`);
    await narrateAll(apiKey, model.classes);
  }

  const report = renderMarkdownReport(model);
  const outputPath = resolve(repoPath, "springlens-report.md");
  writeFileSync(outputPath, report, "utf-8");

  console.log(`Report written to: ${outputPath}`);
  console.log("Codebase Q&A is coming in an upcoming sprint.");
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`SpringLens: unexpected error — ${(err as Error).message}`);
  process.exitCode = 1;
});
