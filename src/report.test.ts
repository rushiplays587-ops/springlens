import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHtml, renderMarkdown, escapeHtml } from "./blocks.js";
import { renderHtmlReport, renderMarkdownReport } from "./report.js";
import { parseConfigFile } from "./config.js";
import { ClassInfo, RepoModel } from "./model.js";

const EVIL = [
  "<script>alert(1)</script>",
  '"><img src=x onerror=alert(2)>',
  "</style><script>alert(3)</script>",
  "'; DROP TABLE x; --",
  "<!-- comment -->",
  "&lt;already&amp;escaped&gt;",
  "javascript:alert(4)",
  "`backtick` | pipe | *star* _under_ [l](javascript:alert(5))",
];

function hostileClass(evil: string): ClassInfo {
  return {
    name: `Cls${evil}`,
    kind: "controller",
    file: `src/${evil}/X.java`,
    annotations: [`Ann${evil}`],
    endpoints: [{ httpMethod: "GET", path: `/p/${evil}`, methodName: `m${evil}` }],
    dependsOn: [`Dep${evil}`],
    rawBody: "",
    narrative: `Narrative ${evil}`,
    configPrefix: `pre${evil}`,
    configKeys: [{ key: `key${evil}`, hasDefault: false }],
  };
}

function hostileModel(): RepoModel {
  const yaml = EVIL.map((e, i) => `k${i}${JSON.stringify(e)}: ${JSON.stringify(e)}`).join("\n");
  const routes = [
    "spring:",
    "  application:",
    `    name: ${JSON.stringify(EVIL[0])}`,
    "  cloud:",
    "    gateway:",
    "      routes:",
    `        - id: ${JSON.stringify(EVIL[1])}`,
    `          uri: ${JSON.stringify(EVIL[2])}`,
    "          predicates:",
    `            - ${JSON.stringify("Path=" + EVIL[0])}`,
    "          filters:",
    `            - ${JSON.stringify("X=" + EVIL[3])}`,
  ].join("\n");
  return {
    rootPath: "/tmp/<script>alert(1)",
    classes: EVIL.map(hostileClass),
    dependencies: [],
    buildFiles: [`pom${EVIL[0]}.xml`],
    riskFindings: [
      {
        dependency: { groupId: EVIL[0], artifactId: EVIL[1], version: "1" },
        severity: "critical",
        message: EVIL[2],
      },
    ],
    configs: [parseConfigFile(`src/${EVIL[0]}/application.yml`, routes), parseConfigFile("application-x.properties", EVIL.map((e, i) => `k${i}=${e}`).join("\n")), parseConfigFile("application-y.yml", "# " + yaml)],
  };
}

const ALLOWED_TAGS = new Set(["html", "head", "meta", "title", "style", "body", "main", "h1", "h2", "h3", "h4", "p", "ul", "li", "table", "thead", "tbody", "tr", "th", "td", "code", "em", "strong", "div"]);

function tagNames(html: string): string[] {
  return [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1].toLowerCase());
}

test("HTML report: hostile text from classes, paths, annotations, endpoints, config and narrative creates no elements beyond the fixed set", () => {
  const html = renderHtmlReport(hostileModel());
  const stray = tagNames(html).filter((t) => !ALLOWED_TAGS.has(t));
  assert.deepEqual(stray, [], `unexpected tags: ${stray.join(",")}`);
});

test("HTML report: no script, no external references, no event-handler attributes, exactly one style element", () => {
  const html = renderHtmlReport(hostileModel());
  assert.ok(!/<script/i.test(html), "<script present");
  for (const bad of ["<link", "<img", "<iframe", "<object", "<embed", "<base", "<form", "<a ", "@import", "url("]) {
    assert.ok(!html.toLowerCase().includes(bad), `${bad} present`);
  }
  assert.equal((html.match(/<style>/g) ?? []).length, 1);
  assert.equal((html.match(/<\/style>/g) ?? []).length, 1);
  // Every attribute in the page is one of ours; none can come from repo text.
  const attrs = [...html.matchAll(/<[a-z0-9]+\s([^>]*)>/gi)].map((m) => m[1]);
  for (const a of attrs) assert.match(a, /^(?:charset="utf-8"|http-equiv="Content-Security-Policy" content="[^"]*"|name="(?:viewport|referrer)" content="[^"]*"|lang="en"|class="(?:note|table-wrap)")$/, a);
});

test("HTML report: the injected strings appear only in escaped form", () => {
  const html = renderHtmlReport(hostileModel());
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;/style&gt;"));
  assert.ok(html.includes("&quot;&gt;&lt;img src=x onerror=alert(2)&gt;"));
  assert.ok(html.includes("&#39;; DROP TABLE"));
  assert.ok(html.includes("&amp;lt;already&amp;amp;escaped&amp;gt;"), "existing entities are escaped, not interpreted");
  assert.ok(!html.includes("<!-- comment -->"));
});

test("HTML report: a Content-Security-Policy forbids scripts and network access even if escaping failed", () => {
  const html = renderHtmlReport(hostileModel());
  const csp = html.match(/Content-Security-Policy" content="([^"]*)"/)?.[1] ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.ok(!/script-src/.test(csp));
  assert.ok(!/connect-src|img-src https?:|font-src|frame-src/.test(csp));
});

test("HTML report: the page is well-formed enough that every opened tag is closed", () => {
  const html = renderHtmlReport(hostileModel());
  const voids = new Set(["meta"]);
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)[^>]*>/gi)) {
    const [, closing, name] = m;
    if (voids.has(name) || name === "html" && false) continue;
    if (closing) assert.equal(stack.pop(), name, `mismatched </${name}>`);
    else stack.push(name);
  }
  assert.deepEqual(stack, []);
});

test("HTML report: has a title from the scanned directory name, escaped, and is printable and responsive", () => {
  const html = renderHtmlReport(hostileModel());
  assert.match(html, /<title>SpringLens — [^<]*&lt;script&gt;/);
  assert.ok(html.includes("@media print"));
  assert.ok(html.includes("width=device-width"));
  assert.ok(html.includes("prefers-color-scheme"));
});

test("HTML report of an empty repo renders the empty-state message", () => {
  const html = renderHtmlReport({ rootPath: "/x/repo", classes: [], dependencies: [], buildFiles: [], riskFindings: [], configs: [] });
  assert.ok(html.includes("No Spring-annotated classes found"));
  assert.ok(html.includes("No application or bootstrap config files"));
});

test("Markdown report: hostile text is neutralised (no raw tags, backticks and pipes cannot break out of code spans or table rows)", () => {
  const md = renderMarkdownReport(hostileModel());
  // Inside a code span Markdown shows text literally; outside one, angle brackets must be escaped.
  const outsideCode = md.split("\n").map((l) => l.replace(/(`+)(.+?)\1(?!`)/g, "")).join("\n");
  assert.ok(!/<script/i.test(outsideCode), "raw <script outside a code span");
  assert.ok(!/<img/i.test(outsideCode));
  assert.ok(!outsideCode.includes("<!--"));
  for (const row of md.split("\n").filter((l) => l.startsWith("|"))) {
    const unescapedPipes = row.replace(/\\\|/g, "").split("|").length - 1;
    const first = md.split("\n").find((l) => l.startsWith("| Route id"))!;
    assert.equal(unescapedPipes, first.replace(/\\\|/g, "").split("|").length - 1, `table row has a different cell count: ${row}`);
  }
});

test("renderMarkdown code spans use a fence longer than any backtick run inside", () => {
  const md = renderMarkdown([{ t: "p", text: [{ code: "a ``` b ` c" }] }]);
  assert.ok(md.includes("```` a ``` b ` c ````") || md.includes("````a ``` b ` c````"), md);
});

test("renderMarkdown keeps newlines from breaking list items or table rows", () => {
  const md = renderMarkdown([
    { t: "ul", items: [[{ code: "line1\nline2" }]] },
    { t: "table", head: ["h"], rows: [[["a\n| b"]]] },
  ]);
  assert.equal(md.split("\n").filter((l) => l.startsWith("- ")).length, 1);
  assert.ok(md.split("\n").every((l) => !l.startsWith("line2")));
});

test("escapeHtml escapes the five significant characters", () => {
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("renderHtml never lets a block title or heading contain live markup", () => {
  const html = renderHtml("</title><script>x</script>", [{ t: "h", level: 2, text: ["</h2><script>y</script>"] }]);
  assert.ok(!/<script/i.test(html));
  assert.equal((html.match(/<title>/g) ?? []).length, 1);
});

test("Markdown report includes the gateway routing table and config usage for a normal config", () => {
  const model: RepoModel = {
    rootPath: "/x/shop",
    classes: [
      {
        name: "NotificationService",
        kind: "service",
        file: "N.java",
        annotations: ["Service"],
        endpoints: [],
        dependsOn: [],
        rawBody: "",
        configKeys: [
          { key: "notify.timeout-seconds", hasDefault: true },
          { key: "missing.setting", hasDefault: false },
        ],
      },
    ],
    dependencies: [],
    buildFiles: [],
    riskFindings: [],
    configs: [
      parseConfigFile(
        "application.yml",
        "notify:\n  timeout-seconds: 3\nspring:\n  cloud:\n    gateway:\n      routes:\n        - id: a\n          uri: lb://a\n          predicates:\n            - Path=/a/**\n"
      ),
    ],
  };
  const md = renderMarkdownReport(model);
  assert.ok(md.includes("| Route id | Target (uri) | Predicates | Filters |"));
  assert.ok(md.includes("| `a` | `lb://a` | `Path=/a/**` | (none) |"));
  assert.ok(md.includes("`notify.timeout-seconds` (defined)"));
  assert.ok(md.includes("`missing.setting` (not in scanned config, no default)"));
});
