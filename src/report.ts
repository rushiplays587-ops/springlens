import { basename } from "node:path";
import { Block, Span, renderHtml, renderMarkdown } from "./blocks.js";
import { isKeyDefined, isPrefixDefined } from "./config.js";
import { ClassInfo, ClassKind, ConfigDocument, ConfigFile, RepoModel } from "./model.js";

const KIND_LABELS: Record<ClassKind, string> = {
  controller: "Controllers",
  advice: "Controller advice",
  service: "Services",
  repository: "Repositories",
  entity: "Entities",
  configuration: "Configuration classes",
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

const MAX_GROUPS_SHOWN = 10;

function joinSpans(items: string[]): Span[] {
  return items.flatMap((item, i) => (i === 0 ? [{ code: item }] : [", ", { code: item }]));
}

function classBlocks(cls: ClassInfo): Block[] {
  const blocks: Block[] = [{ t: "h", level: 3, text: [cls.name] }];
  const label: Span[] =
    cls.annotations.length > 0
      ? [{ i: cls.file }, " — ", { code: cls.annotations.map((a) => "@" + a).join(" ") }]
      : [{ i: cls.file }, " — Spring Data interface"];
  blocks.push({ t: "p", text: label });

  if (cls.narrative) blocks.push({ t: "p", text: [{ text: cls.narrative }] });

  if (cls.endpoints.length > 0) {
    blocks.push({ t: "p", text: ["Endpoints:"] });
    blocks.push({
      t: "ul",
      items: cls.endpoints.map((ep) => [
        { code: `${ep.httpMethod} ${ep.path || "(path not statically resolvable)"}` },
        " → ",
        { code: `${ep.methodName}()` },
      ]),
    });
  }

  if (cls.dependsOn.length > 0) {
    blocks.push({ t: "p", text: ["Depends on: ", ...joinSpans(cls.dependsOn)] });
  }
  return blocks;
}

function dependencyRiskBlocks(model: RepoModel): Block[] {
  const blocks: Block[] = [{ t: "h", level: 2, text: ["Dependency risk"] }];
  blocks.push({
    t: "note",
    text: [
      "Checked against a small curated list of well-established issues " +
        "(e.g. Log4Shell's fixed-version boundary, Spring Boot's published " +
        "end-of-life) — not a live vulnerability database. Run a real scanner " +
        "(OWASP dependency-check, Snyk, GitHub Dependabot) for full coverage.",
    ],
  });

  if (model.buildFiles.length === 0) {
    blocks.push({ t: "p", text: ["No pom.xml or build.gradle(.kts) found at the repo root — skipped."] });
  } else if (model.dependencies.length === 0) {
    blocks.push({
      t: "p",
      text: [
        "Read ",
        ...joinSpans(model.buildFiles),
        " but found no dependencies to check " +
          "(map-style Gradle notation and multi-project Gradle builds are not supported yet).",
      ],
    });
  } else if (model.riskFindings.length === 0) {
    blocks.push({
      t: "p",
      text: [`Scanned ${model.dependencies.length} dependencies from `, ...joinSpans(model.buildFiles), " — nothing flagged."],
    });
  } else {
    blocks.push({
      t: "ul",
      items: model.riskFindings.map((f) => [
        { b: f.severity === "critical" ? "🔴 critical" : "🟡 advisory" },
        " ",
        { code: `${f.dependency.groupId}:${f.dependency.artifactId}` },
        " — ",
        { text: f.message },
      ]),
    });
  }
  return blocks;
}

function documentBlocks(doc: ConfigDocument, heading: Span[] | null): Block[] {
  const blocks: Block[] = [];
  if (heading) blocks.push({ t: "h", level: 4, text: heading });
  const s = doc.summary;
  const items: Span[][] = [];

  if (s.applicationName) items.push(["Application name: ", { code: s.applicationName }]);
  if (s.port) items.push(["Server port: ", { code: s.port }]);
  if (s.contextPath) items.push(["Context path: ", { code: s.contextPath }]);
  for (const p of s.profiles) items.push(["Profiles: ", { code: p.key }, " = ", { code: p.value }]);
  for (const b of s.backends) {
    items.push(["Data source: ", { code: b.kind }, " at ", { code: b.target }, " (", { code: b.key }, ")"]);
  }
  if (s.discovery) items.push(["Service discovery (Eureka): ", { code: s.discovery }]);
  for (const c of s.configImports) items.push(["Config import / config server: ", { code: c }]);
  for (const c of s.configServer) items.push(["Config server setting: ", { code: c }]);
  if (s.groups.length > 0) {
    const shown = s.groups.slice(0, MAX_GROUPS_SHOWN).map((g) => `${g.name} (${g.count})`);
    const more = s.groups.length - shown.length;
    items.push(["Property groups: ", ...joinSpans(shown), more > 0 ? ` and ${more} more` : ""]);
  }
  if (items.length > 0) blocks.push({ t: "ul", items });
  else blocks.push({ t: "p", text: ["No properties found in this document."] });

  if (s.routes.length > 0 || s.defaultFilters.length > 0 || s.discoveryLocator) {
    blocks.push({ t: "p", text: [{ b: "Gateway routing" }] });
    if (s.routes.length > 0) {
      blocks.push({
        t: "table",
        head: ["Route id", "Target (uri)", "Predicates", "Filters"],
        rows: s.routes.map((r) => [
          [{ code: r.id || "(no id)" }],
          [{ code: r.uri || "(none)" }],
          r.predicates.length > 0 ? joinSpans(r.predicates) : ["(none)"],
          r.filters.length > 0 ? joinSpans(r.filters) : ["(none)"],
        ]),
      });
    }
    if (s.defaultFilters.length > 0) {
      blocks.push({ t: "p", text: ["Default filters applied to every route: ", ...joinSpans(s.defaultFilters)] });
    }
    if (s.discoveryLocator) {
      blocks.push({ t: "p", text: ["Discovery locator enabled: ", { code: s.discoveryLocator }] });
    }
  }
  if (doc.truncated) {
    blocks.push({ t: "note", text: ["This file was larger or deeper than SpringLens reads; the rest was ignored."] });
  }
  return blocks;
}

function configFileBlocks(cfg: ConfigFile): Block[] {
  const blocks: Block[] = [{ t: "h", level: 3, text: [{ code: cfg.file }] }];
  blocks.push({
    t: "p",
    text: [
      `${cfg.bootstrap ? "bootstrap" : "application"}, ${cfg.format}, `,
      ...(cfg.profile ? ["profile ", { code: cfg.profile }] : ["default profile"]),
    ],
  });
  if (cfg.error) blocks.push({ t: "p", text: ["Could not be fully read: ", { code: cfg.error }] });

  cfg.documents.forEach((doc, i) => {
    let heading: Span[] | null = null;
    if (cfg.documents.length > 1 || doc.onProfile) {
      heading = [`Document ${i + 1}`, ...(doc.onProfile ? [" — profile ", { code: doc.onProfile }] : [" — no profile condition"])];
    }
    blocks.push(...documentBlocks(doc, heading));
  });
  return blocks;
}

function configUsageBlocks(model: RepoModel): Block[] {
  const users = model.classes.filter((c) => c.configPrefix !== undefined || (c.configKeys?.length ?? 0) > 0);
  if (users.length === 0) return [];

  const blocks: Block[] = [{ t: "h", level: 3, text: ["Configuration read by code"] }];
  const items: Span[][] = [];
  for (const cls of users) {
    const parts: Span[] = [{ code: cls.name }, " — "];
    const reads: Span[][] = [];
    if (cls.configPrefix !== undefined) {
      const found = isPrefixDefined(model.configs, cls.configPrefix);
      reads.push(["binds ", { code: `${cls.configPrefix}.*` }, found ? " (defined in scanned config)" : " (not in scanned config)"]);
    }
    for (const k of cls.configKeys ?? []) {
      const found = isKeyDefined(model.configs, k.key);
      const status = found ? "defined" : k.hasDefault ? "not in scanned config, has a default" : "not in scanned config, no default";
      reads.push(["reads ", { code: k.key }, ` (${status})`]);
    }
    reads.forEach((r, i) => parts.push(...(i > 0 ? ["; "] : []), ...r));
    items.push(parts);
  }
  blocks.push({ t: "ul", items });
  blocks.push({
    t: "note",
    text: [
      "\"Not in scanned config\" means no application/bootstrap file in this repo sets the key; it may still come " +
        "from environment variables, a config server, or a profile file outside the scan.",
    ],
  });
  return blocks;
}

function configurationBlocks(model: RepoModel): Block[] {
  const blocks: Block[] = [{ t: "h", level: 2, text: ["Configuration files"] }];
  blocks.push({
    t: "note",
    text: [
      "Values under keys that look secret (password, token, key, credential, ...) and credentials inside URLs are " +
        "redacted. Files are shown as written: profiles are not merged and environment variables or config-server " +
        "values are not resolved.",
    ],
  });
  if (model.configs.length === 0) {
    blocks.push({ t: "p", text: ["No application or bootstrap config files (.yml, .yaml, .properties) found."] });
  }
  for (const cfg of [...model.configs].sort((a, b) => a.file.localeCompare(b.file))) {
    blocks.push(...configFileBlocks(cfg));
  }
  blocks.push(...configUsageBlocks(model));
  return blocks;
}

/** The whole report as format-neutral blocks; the Markdown and HTML outputs are both rendered from this. */
export function buildReportBlocks(model: RepoModel): Block[] {
  const blocks: Block[] = [
    { t: "h", level: 1, text: ["SpringLens architecture map"] },
    { t: "p", text: ["Scanned: ", { code: basename(model.rootPath) }] },
    { t: "p", text: [`Classes found: ${model.classes.length}`] },
    ...dependencyRiskBlocks(model),
    ...configurationBlocks(model),
  ];

  if (model.classes.length === 0) {
    blocks.push({
      t: "p",
      text: [
        "No Spring-annotated classes found. Is this a Spring Boot project, and " +
          "did you point SpringLens at the right directory (e.g. the module " +
          "containing `src/main/java`)?",
      ],
    });
    return blocks;
  }

  for (const kind of KIND_ORDER) {
    const classesOfKind = model.classes.filter((c) => c.kind === kind);
    if (classesOfKind.length === 0) continue;
    blocks.push({ t: "h", level: 2, text: [`${KIND_LABELS[kind]} (${classesOfKind.length})`] });
    for (const cls of classesOfKind) blocks.push(...classBlocks(cls));
  }
  return blocks;
}

/**
 * Renders the full architecture-map report as Markdown: dependency risk, the
 * configuration files, then one section per Spring "kind". Only the scanned
 * directory's name is printed, not its absolute path, so a report committed to
 * a repo doesn't leak local usernames or folder layout.
 */
export function renderMarkdownReport(model: RepoModel): string {
  return renderMarkdown(buildReportBlocks(model));
}

/** The same report as one self-contained HTML page (inline CSS, no scripts, no external requests). */
export function renderHtmlReport(model: RepoModel): string {
  return renderHtml(`SpringLens — ${basename(model.rootPath)}`, buildReportBlocks(model));
}
