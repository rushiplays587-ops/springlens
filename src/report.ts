import { ClassInfo, ClassKind, RepoModel } from "./model.js";

const KIND_LABELS: Record<ClassKind, string> = {
  controller: "Controllers",
  service: "Services",
  repository: "Repositories",
  entity: "Entities",
  configuration: "Configuration",
  component: "Components",
  other: "Other",
};

const KIND_ORDER: ClassKind[] = [
  "controller",
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
  lines.push(`*${cls.file}* — \`${cls.annotations.map((a) => "@" + a).join(" ")}\``);

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

/**
 * Renders the full architecture-map report as Markdown: one section per
 * Spring "kind" (Controllers, Services, ...), each listing its classes with
 * their endpoints (controllers only) and resolved dependencies.
 */
export function renderMarkdownReport(model: RepoModel): string {
  const lines: string[] = [];
  lines.push(`# SpringLens architecture map`);
  lines.push("");
  lines.push(`Scanned: \`${model.rootPath}\``);
  lines.push(`Classes found: ${model.classes.length}`);
  lines.push("");

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
