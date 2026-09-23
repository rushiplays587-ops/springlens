import { basename } from "node:path";
import { ClassInfo, ClassKind, RepoModel } from "./model.js";

const KIND_LABELS: Record<ClassKind, string> = {
  controller: "Controllers",
  advice: "Controller advice",
  service: "Services",
  repository: "Repositories",
  entity: "Entities",
  configuration: "Configuration",
  component: "Components",
  other: "Other",
};

const KIND_ORDER: ClassKind[] = [
  "controller",
  "advice",
  "service",
  "repository",
  "entity",
  "configuration",
  "component",
  "other",
];

function renderClass(cls: ClassInfo): string {
  const lines: string[] = [];
  lines.push(`### ${cls.name}`);
  const annotationText =
    cls.annotations.length > 0
      ? ` — \`${cls.annotations.map((a) => "@" + a).join(" ")}\``
      : " — Spring Data interface";
  lines.push(`*${cls.file}*${annotationText}`);

  if (cls.narrative) {
    lines.push("");
    lines.push(cls.narrative);
  }

  if (cls.endpoints.length > 0) {
    lines.push("");
    lines.push("Endpoints:");
    for (const ep of cls.endpoints) {
      const path = ep.path || "(path not statically resolvable)";
      lines.push(`- \`${ep.httpMethod} ${path}\` → \`${ep.methodName}()\``);
    }
  }

  if (cls.dependsOn.length > 0) {
    lines.push("");
    lines.push(`Depends on: ${cls.dependsOn.map((d) => "`" + d + "`").join(", ")}`);
  }

  return lines.join("\n");
}

function renderDependencyRiskSection(model: RepoModel): string[] {
  const lines: string[] = [];
  lines.push(`## Dependency risk`);
  lines.push("");
  lines.push(
    "_Checked against a small curated list of well-established issues " +
      "(e.g. Log4Shell's fixed-version boundary, Spring Boot's published " +
      "end-of-life) — not a live vulnerability database. Run a real scanner " +
      "(OWASP dependency-check, Snyk, GitHub Dependabot) for full coverage._"
  );
  lines.push("");

  if (model.buildFiles.length === 0) {
    lines.push("No pom.xml or build.gradle(.kts) found at the repo root — skipped.");
    lines.push("");
    return lines;
  }

  if (model.dependencies.length === 0) {
    lines.push(
      `Read ${model.buildFiles.join(", ")} but found no dependencies to check ` +
        "(map-style Gradle notation and multi-project Gradle builds are not supported yet)."
    );
    lines.push("");
    return lines;
  }

  if (model.riskFindings.length === 0) {
    lines.push(
      `Scanned ${model.dependencies.length} dependencies from ${model.buildFiles.join(", ")} — nothing flagged.`
    );
    lines.push("");
    return lines;
  }

  for (const finding of model.riskFindings) {
    const marker = finding.severity === "critical" ? "🔴 critical" : "🟡 advisory";
    lines.push(
      `- **${marker}** \`${finding.dependency.groupId}:${finding.dependency.artifactId}\` — ${finding.message}`
    );
  }
  lines.push("");
  return lines;
}

/**
 * Renders the full architecture-map report as Markdown: one section per
 * Spring "kind" (Controllers, Services, ...), each listing its classes with
 * their endpoints (controllers only) and resolved dependencies. Only the
 * scanned directory's name is printed, not its absolute path, so a report
 * committed to a repo doesn't leak local usernames or folder layout.
 */
export function renderMarkdownReport(model: RepoModel): string {
  const lines: string[] = [];
  lines.push(`# SpringLens architecture map`);
  lines.push("");
  lines.push(`Scanned: \`${basename(model.rootPath)}\``);
  lines.push(`Classes found: ${model.classes.length}`);
  lines.push("");
  lines.push(...renderDependencyRiskSection(model));

  if (model.classes.length === 0) {
    lines.push(
      "No Spring-annotated classes found. Is this a Spring Boot project, and " +
        "did you point SpringLens at the right directory (e.g. the module " +
        "containing `src/main/java`)?"
    );
    return lines.join("\n");
  }

  for (const kind of KIND_ORDER) {
    const classesOfKind = model.classes.filter((c) => c.kind === kind);
    if (classesOfKind.length === 0) continue;

    lines.push(`## ${KIND_LABELS[kind]} (${classesOfKind.length})`);
    lines.push("");
    for (const cls of classesOfKind) {
      lines.push(renderClass(cls));
      lines.push("");
    }
  }

  return lines.join("\n");
}
