#!/usr/bin/env node
import { existsSync, lstatSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildRepoModel } from "./build.js";
import { renderHtmlReport, renderMarkdownReport } from "./report.js";
import Anthropic from "@anthropic-ai/sdk";
import {
  MAX_BODY_CHARS,
  MAX_CONFIG_PROMPT_LINES,
  NARRATION_MODEL,
  answerQuestion,
  narrateAll,
} from "./narrate.js";
import {
  DEFAULT_RESULT_COUNT,
  MAX_QUESTION_CHARS,
  buildIndex,
  formatAnswer,
  rankAll,
} from "./ask.js";

const VERSION = "0.1.0";
const KNOWN_FLAGS = new Set(["--ai", "--no-ai", "--html", "--help", "-h"]);

function printUsage(): void {
  console.log(`SpringLens v${VERSION}
Onboarding and dependency-risk analysis for Java/Spring Boot codebases.

Usage:
  springlens <path-to-repo> [--ai] [--html]
  springlens ask <path-to-repo> "<question>" [--ai]
  springlens ask <path-to-repo> [--ai] -- "-Xmx flag"   (a question starting with "-")

Examples:
  springlens ./my-legacy-service
  springlens ask ./my-legacy-service "where is user login handled"

(To scan a directory literally named "ask", write ./ask.)

By default SpringLens runs entirely locally and writes a structural report
(springlens-report.md inside the repo). Nothing leaves your machine.

--html also write springlens-report.html: the same report as one self-contained page
       (inline styles, no scripts, no external requests). Nothing extra is sent anywhere.

--ai   also generate a plain-English explanation per class using the Anthropic
       API. This SENDS class source code (up to ${MAX_BODY_CHARS} characters per class,
       including string literals such as URLs and config values) to Anthropic.
       Requires the ANTHROPIC_API_KEY environment variable.

ask    answers a question about the repo. By default it is local: it ranks the
       repo's classes by keyword relevance and prints the best matches, and
       makes no AI answer. With --ai it also sends your question plus the source
       of only the top ${DEFAULT_RESULT_COUNT} matching classes (up to ${MAX_BODY_CHARS} characters each,
       string literals included) to the Anthropic API for a written answer.
`);
}

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false; // does not exist
  }
}

/** Resolves and validates the repo directory; prints the error and sets the exit code on failure. */
function checkRepoDir(target: string): string | null {
  const repoPath = resolve(target);
  if (!existsSync(repoPath)) {
    console.error(`SpringLens: path not found — ${repoPath}`);
    process.exitCode = 1;
    return null;
  }
  if (!statSync(repoPath).isDirectory()) {
    console.error(`SpringLens: ${repoPath} is a file — point SpringLens at the repo's directory.`);
    process.exitCode = 1;
    return null;
  }
  return repoPath;
}

async function runAsk(positional: string[], wantsAi: boolean): Promise<void> {
  const [, target, ...questionWords] = positional;
  const question = questionWords.join(" ").trim();
  if (!target || !question) {
    console.error('SpringLens: usage — springlens ask <path-to-repo> "<question>" [--ai]');
    process.exitCode = 2;
    return;
  }
  if (question.length > MAX_QUESTION_CHARS) {
    console.error(`SpringLens: question is ${question.length} characters; the limit is ${MAX_QUESTION_CHARS}.`);
    process.exitCode = 2;
    return;
  }
  const repoPath = checkRepoDir(target);
  if (!repoPath) return;

  const model = buildRepoModel(repoPath);
  const results = rankAll(buildIndex(model.classes, model.configs), question, DEFAULT_RESULT_COUNT);
  console.log(formatAnswer(question, results, model.classes, wantsAi, model.configs.length));

  if (!wantsAi) return;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("\n--ai given but ANTHROPIC_API_KEY is not set — local results only.");
    return;
  }
  if (results.length === 0) {
    console.log("\n--ai: nothing retrieved, so nothing was sent to the Anthropic API.");
    return;
  }
  const classes = results.flatMap((r) => (r.type === "class" ? [r.cls] : []));
  const configs = results.flatMap((r) => (r.type === "config" ? [r.config] : []));
  const sent: string[] = [];
  if (classes.length > 0) {
    sent.push(
      `the source of ${classes.length} classes (${classes.map((c) => c.name).join(", ")}; up to ` +
        `${MAX_BODY_CHARS} characters each, string literals included)`
    );
  }
  if (configs.length > 0) {
    sent.push(
      `${configs.length} config files as key = value lines (${configs.map((c) => c.file).join(", ")}; up to ` +
        `${MAX_CONFIG_PROMPT_LINES} lines each; values under secret-looking keys and credentials in URLs are redacted)`
    );
  }
  console.log(`\n--ai: sending your question and ${sent.join(" and ")} to the Anthropic API using model ${NARRATION_MODEL}.`);
  const answer = await answerQuestion(new Anthropic({ apiKey }), question, classes, model.classes.length, configs);
  console.log(answer ? `\nAI answer:\n${answer}` : "\nNo AI answer was produced; see the local results above.");
}

async function main(argv: string[]): Promise<void> {
  // Everything after a bare "--" is positional; a dash-led argument containing whitespace is
  // a quoted sentence (e.g. a question), not an option.
  const dashDash = argv.indexOf("--");
  const optionArgs = dashDash === -1 ? argv : argv.slice(0, dashDash);
  const trailing = dashDash === -1 ? [] : argv.slice(dashDash + 1);
  const isOption = (a: string) => a.startsWith("-") && !/\s/.test(a);
  const flags = optionArgs.filter(isOption);
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

  const positional = [...optionArgs.filter((a) => !isOption(a)), ...trailing];
  if (positional[0] === "ask" && !flags.includes("--help") && !flags.includes("-h")) {
    await runAsk(positional, flags.includes("--ai"));
    return;
  }

  const target = positional[0];
  if (!target || flags.includes("--help") || flags.includes("-h")) {
    printUsage();
    return;
  }

  const repoPath = checkRepoDir(target);
  if (!repoPath) return;

  const outputPath = resolve(repoPath, "springlens-report.md");
  const htmlPath = resolve(repoPath, "springlens-report.html");
  const wantsHtml = flags.includes("--html");
  for (const path of wantsHtml ? [outputPath, htmlPath] : [outputPath]) {
    if (isSymbolicLink(path)) {
      console.error(`SpringLens: refusing to write ${path} because it is a symbolic link. Remove it and re-run.`);
      process.exitCode = 1;
      return;
    }
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
  if (wantsHtml) writeFileSync(htmlPath, renderHtmlReport(model), "utf-8");

  console.log(`Report written to: ${outputPath}`);
  if (wantsHtml) console.log(`HTML report written to: ${htmlPath}`);
  console.log(`Ask a question about the codebase: springlens ask ${target} "<question>"`);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`SpringLens: unexpected error — ${(err as Error).message}`);
  process.exitCode = 1;
});
