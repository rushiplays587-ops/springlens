#!/usr/bin/env node
import { existsSync, lstatSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildRepoModel } from "./build.js";
import { renderMarkdownReport } from "./report.js";
import { MAX_BODY_CHARS, NARRATION_MODEL, narrateAll } from "./narrate.js";

const VERSION = "0.1.0";
const KNOWN_FLAGS = new Set(["--ai", "--no-ai", "--help", "-h"]);

function printUsage(): void {
  console.log(`SpringLens v${VERSION}
Onboarding and dependency-risk analysis for Java/Spring Boot codebases.

Usage:
  springlens <path-to-repo> [--ai]

Example:
  springlens ./my-legacy-service

By default SpringLens runs entirely locally and writes a structural report
(springlens-report.md inside the repo). Nothing leaves your machine.

--ai   also generate a plain-English explanation per class using the Anthropic
       API. This SENDS class source code (up to ${MAX_BODY_CHARS} characters per class,
       including string literals such as URLs and config values) to Anthropic.
       Requires the ANTHROPIC_API_KEY environment variable.
`);
}

async function main(argv: string[]): Promise<void> {
  const flags = argv.filter((a) => a.startsWith("-"));
  const unknown = flags.filter((f) => !KNOWN_FLAGS.has(f));
  if (unknown.length > 0) {
    console.error(`SpringLens: unknown option ${unknown.join(", ")}. Run with --help for usage.`);
    process.exitCode = 2;
    return;
  }
  if (flags.includes("--ai") && flags.includes("--no-ai")) {
    console.error("SpringLens: --ai and --no-ai contradict each other; pass only one.");
    process.exitCode = 2;
    return;
  }

  const target = argv.find((a) => !a.startsWith("-"));
  if (!target || flags.includes("--help") || flags.includes("-h")) {
    printUsage();
    return;
  }

  const repoPath = resolve(target);

  if (!existsSync(repoPath)) {
    console.error(`SpringLens: path not found — ${repoPath}`);
    process.exitCode = 1;
    return;
  }
  if (!statSync(repoPath).isDirectory()) {
    console.error(`SpringLens: ${repoPath} is a file — point SpringLens at the repo's directory.`);
    process.exitCode = 1;
    return;
  }

  const outputPath = resolve(repoPath, "springlens-report.md");
  if (existsSync(outputPath) && lstatSync(outputPath).isSymbolicLink()) {
    console.error(
      `SpringLens: refusing to write ${outputPath} because it is a symbolic link. Remove it and re-run.`
    );
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

  const wantsAi = flags.includes("--ai");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!wantsAi) {
    console.log(
      "Local structural report only. Pass --ai (needs ANTHROPIC_API_KEY) for plain-English " +
        "explanations — note that sends class source to the Anthropic API."
    );
  } else if (!apiKey) {
    console.log(
      "--ai given but ANTHROPIC_API_KEY is not set — writing the structural report only."
    );
  } else if (model.classes.length > 0) {
    console.log(
      `--ai: sending the source of ${model.classes.length} classes (up to ${MAX_BODY_CHARS} characters each, ` +
        `string literals included) to the Anthropic API using model ${NARRATION_MODEL}.`
    );
    await narrateAll(apiKey, model.classes);
  }

  const report = renderMarkdownReport(model);
  writeFileSync(outputPath, report, "utf-8");

  console.log(`Report written to: ${outputPath}`);
  console.log("Codebase Q&A is coming in an upcoming sprint.");
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`SpringLens: unexpected error — ${(err as Error).message}`);
  process.exitCode = 1;
});
