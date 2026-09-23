import { Dependency, RiskFinding } from "./model.js";

/**
 * v1 scope, stated plainly: this is a small curated table of well-established,
 * unambiguous facts (a famous CVE's fixed-version boundary, a framework's
 * published end-of-life date) — not a live vulnerability database. It will
 * miss things a real scanner (OWASP dependency-check, Snyk, GitHub
 * Dependabot) would catch. Said explicitly in the report output too, so
 * nobody mistakes this for more coverage than it actually has. Extending
 * this list, or wiring in a real feed (e.g. OSV.dev's API) is a reasonable
 * future sprint if this proves useful enough to be worth the added
 * complexity and network dependency.
 */

/** Compares two dotted numeric version strings, e.g. "2.17.1" vs "2.14.1". Non-numeric qualifiers (like "-RELEASE") are ignored. Returns <0, 0, or >0 like a normal comparator. */
export function compareVersions(a: string, b: string): number {
  const clean = (v: string) => v.split(/[-+]/)[0].split(".").map((n) => parseInt(n, 10) || 0);
  const pa = clean(a);
  const pb = clean(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True when a version is a build property, range or other expression SpringLens cannot evaluate statically. */
export function isUnresolvedVersion(version: string): boolean {
  return /[${}\[\](),]/.test(version) || !/^\d/.test(version);
}

interface RiskRule {
  groupId: string;
  artifactIds: string[];
  /** One-line statement of what a safe version looks like, used when the version can't be resolved. */
  hint: string;
  check(version: string): { severity: "critical" | "advisory"; message: string } | null;
}

const RISK_RULES: RiskRule[] = [
  {
    groupId: "org.apache.logging.log4j",
    artifactIds: ["log4j-core"],
    hint: "it should be 2.17.1 or later (or 2.12.4 / 2.3.2 on the Java 7 / Java 6 lines)",
    check(version) {
      // Apache publishes patched backports for older Java baselines: 2.12.4
      // for Java 7 and 2.3.2 for Java 6. They are older than 2.17.1 but fixed.
      const [major, minor] = version.split(/[-+]/)[0].split(".").map((n) => parseInt(n, 10) || 0);
      const patchedBackport =
        major === 2 &&
        ((minor === 12 && compareVersions(version, "2.12.4") >= 0) ||
          (minor === 3 && compareVersions(version, "2.3.2") >= 0));
      if (patchedBackport) return null;

      if (compareVersions(version, "2.17.1") < 0) {
        return {
          severity: "critical",
          message:
            `log4j-core ${version} is older than 2.17.1 — within the "Log4Shell" ` +
            "family of vulnerabilities (CVE-2021-44228 and related). Upgrade to " +
            "2.17.1 or later (or 2.12.4 / 2.3.2 if you are stuck on Java 7 / Java 6).",
        };
      }
      return null;
    },
  },
  {
    groupId: "org.springframework.boot",
    artifactIds: ["spring-boot-starter-parent", "spring-boot-gradle-plugin"],
    hint: "Spring Boot 1.x and 2.x are both past open-source end-of-life",
    check(version) {
      const major = parseInt(version.split(".")[0], 10);
      if (major === 1) {
        return {
          severity: "critical",
          message:
            `Spring Boot ${version} is a 1.x release — end-of-life, no security ` +
            "patches. Upgrading to 3.x is a significant jump (requires Java 17+ and " +
            "a javax.* → jakarta.* namespace migration) but 2.x is also EOL for " +
            "open-source support, so it's the only real target.",
        };
      }
      if (major === 2) {
        return {
          severity: "advisory",
          message:
            `Spring Boot ${version} is a 2.x release. Open-source community support ` +
            "for the 2.x line has ended (commercial support only past that point) — " +
            "worth planning the move to 3.x, which requires Java 17+ and a " +
            "javax.* → jakarta.* namespace migration for anything using " +
            "Servlet/JPA/Validation APIs.",
        };
      }
      return null;
    },
  },
];

export function assessDependencies(deps: Dependency[]): RiskFinding[] {
  const findings: RiskFinding[] = [];

  for (const dep of deps) {
    if (!dep.version) continue; // version managed externally (parent/BOM) — nothing to check here

    for (const rule of RISK_RULES) {
      if (rule.groupId !== dep.groupId || !rule.artifactIds.includes(dep.artifactId)) continue;

      if (isUnresolvedVersion(dep.version)) {
        findings.push({
          dependency: dep,
          severity: "advisory",
          message:
            `Version \`${dep.version}\` is a build property or range that SpringLens ` +
            `can't resolve — check by hand that ${dep.artifactId} is on a safe release ` +
            `(${rule.hint}).`,
        });
        continue;
      }

      const result = rule.check(dep.version);
      if (result) {
        findings.push({ dependency: dep, severity: result.severity, message: result.message });
      }
    }
  }

  return findings;
}

/** Module directory names declared in a pom's <modules> block. */
export function parsePomModules(xml: string): string[] {
  const clean = xml.replace(/<!--[\s\S]*?-->/g, "");
  const block = clean.match(/<modules>([\s\S]*?)<\/modules>/)?.[1] ?? "";
  return [...block.matchAll(/<module>([^<]+)<\/module>/g)].map((m) => m[1].trim());
}

/**
 * Extracts <dependency> entries from a Maven pom.xml, deliberately excluding
 * anything inside <dependencyManagement> — those are version-pinning
 * declarations, not dependencies actually used by this module, and
 * reporting them as risks would be misleading. XML comments are ignored, and
 * simple ${property} versions are resolved from the pom's own <properties>
 * block. The project's parent (<parent>...</parent>, most commonly
 * spring-boot-starter-parent) is included too since that's where a Spring
 * Boot project's own version usually lives.
 */
export function parsePomDependencies(rawXml: string): Dependency[] {
  const xml = rawXml.replace(/<!--[\s\S]*?-->/g, "");

  const properties = new Map<string, string>();
  const propsBlock = xml.match(/<properties>([\s\S]*?)<\/properties>/)?.[1] ?? "";
  for (const p of propsBlock.matchAll(/<([\w.\-]+)>([^<]*)<\/\1>/g)) {
    properties.set(p[1], p[2].trim());
  }
  const resolve = (v: string | undefined): string | undefined =>
    v?.replace(/\$\{([^}]+)\}/g, (whole, name) => properties.get(name) ?? whole);

  const withoutDependencyManagement = xml.replace(
    /<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g,
    ""
  );

  const deps: Dependency[] = [];
  const depBlockRegex = /<dependency>([\s\S]*?)<\/dependency>/g;
  let match: RegExpExecArray | null;

  while ((match = depBlockRegex.exec(withoutDependencyManagement)) !== null) {
    const block = match[1];
    const groupId = block.match(/<groupId>([^<]+)<\/groupId>/)?.[1]?.trim();
    const artifactId = block.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]?.trim();
    const version = resolve(block.match(/<version>([^<]+)<\/version>/)?.[1]?.trim());
    if (groupId && artifactId) {
      deps.push({ groupId, artifactId, version: version ?? null });
    }
  }

  const parentBlock = xml.match(/<parent>([\s\S]*?)<\/parent>/)?.[1];
  if (parentBlock) {
    const groupId = parentBlock.match(/<groupId>([^<]+)<\/groupId>/)?.[1]?.trim();
    const artifactId = parentBlock.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]?.trim();
    const version = resolve(parentBlock.match(/<version>([^<]+)<\/version>/)?.[1]?.trim());
    if (groupId && artifactId && version) {
      deps.push({ groupId, artifactId, version });
    }
  }

  return deps;
}

/**
 * Best-effort extraction from a Gradle build script: the conventional
 * string-notation dependencies (`implementation 'group:artifact:version'`,
 * double-quoted and parenthesised Kotlin-DSL variants, legacy `compile` /
 * `testCompile` / `classpath` configurations) plus the Spring Boot plugin
 * version. Comments are ignored. Gradle files are Groovy/Kotlin scripts, not
 * data — a dependency declared via the map-style notation
 * (`group: 'x', name: 'y', ...`) or built up dynamically won't be picked up,
 * and multi-project Gradle builds are not followed.
 */
export function parseGradleDependencies(content: string): Dependency[] {
  const clean = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const deps: Dependency[] = [];

  const depRegex =
    /\b(?:implementation|api|compile|compileOnly|runtimeOnly|runtime|testImplementation|testCompile|testCompileOnly|testRuntimeOnly|testRuntime|annotationProcessor|classpath|developmentOnly|kapt)\s*[( ]\s*['"]([^:'"\s]+):([^:'"\s]+)(?::([^:'"\s)@]+))?[^'"]*['"]/g;
  let match: RegExpExecArray | null;
  while ((match = depRegex.exec(clean)) !== null) {
    deps.push({ groupId: match[1], artifactId: match[2], version: match[3] ?? null });
  }

  const pluginRegex =
    /\bid\s*\(?\s*['"]org\.springframework\.boot['"]\s*\)?\s*version\s*\(?\s*['"]([^'"]+)['"]/g;
  while ((match = pluginRegex.exec(clean)) !== null) {
    deps.push({
      groupId: "org.springframework.boot",
      artifactId: "spring-boot-gradle-plugin",
      version: match[1],
    });
  }

  return deps;
}
