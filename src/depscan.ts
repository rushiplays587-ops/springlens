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

interface RiskRule {
  groupId: string;
  artifactId: string;
  check(version: string): { severity: "critical" | "advisory"; message: string } | null;
}

const RISK_RULES: RiskRule[] = [
  {
    groupId: "org.apache.logging.log4j",
    artifactId: "log4j-core",
    check(version) {
      if (compareVersions(version, "2.17.1") < 0) {
        return {
          severity: "critical",
          message:
            `log4j-core ${version} is older than 2.17.1 — within the "Log4Shell" ` +
            "family of vulnerabilities (CVE-2021-44228 and related). Upgrade to " +
            "2.17.1 or later.",
        };
      }
      return null;
    },
  },
  {
    groupId: "org.springframework.boot",
    artifactId: "spring-boot-starter-parent",
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
      if (rule.groupId === dep.groupId && rule.artifactId === dep.artifactId) {
        const result = rule.check(dep.version);
        if (result) {
          findings.push({ dependency: dep, severity: result.severity, message: result.message });
        }
      }
    }
  }

  return findings;
}

/**
 * Extracts <dependency> entries from a Maven pom.xml, deliberately excluding
 * anything inside <dependencyManagement> — those are version-pinning
 * declarations, not dependencies actually used by this module, and
 * reporting them as risks would be misleading. The project's parent
 * (<parent>...</parent>, most commonly spring-boot-starter-parent) is
 * included too since that's where a Spring Boot project's own version
 * usually lives.
 */
export function parsePomDependencies(xml: string): Dependency[] {
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
    const version = block.match(/<version>([^<]+)<\/version>/)?.[1]?.trim();
    if (groupId && artifactId) {
      deps.push({ groupId, artifactId, version: version ?? null });
    }
  }

  const parentBlock = xml.match(/<parent>([\s\S]*?)<\/parent>/)?.[1];
  if (parentBlock) {
    const groupId = parentBlock.match(/<groupId>([^<]+)<\/groupId>/)?.[1]?.trim();
    const artifactId = parentBlock.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]?.trim();
    const version = parentBlock.match(/<version>([^<]+)<\/version>/)?.[1]?.trim();
    if (groupId && artifactId && version) {
      deps.push({ groupId, artifactId, version });
    }
  }

  return deps;
}

/**
 * Best-effort extraction of Gradle's short-form dependency declarations
 * (e.g. `implementation 'group:artifact:version'` or the double-quoted /
 * parenthesised variants). Gradle build files are Groovy/Kotlin scripts,
 * not data — this only catches the conventional string-notation form, which
 * covers the large majority of real Gradle dependency declarations, but a
 * dependency declared via the map-style notation (`group: 'x', name: 'y', ...`)
 * or built up dynamically won't be picked up.
 */
export function parseGradleDependencies(content: string): Dependency[] {
  const deps: Dependency[] = [];
  const regex =
    /\b(?:implementation|api|compileOnly|runtimeOnly|testImplementation|annotationProcessor)\s*[( ]\s*['"]([^:'"]+):([^:'"]+):([^:'")\s]+)['"]/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    deps.push({ groupId: match[1], artifactId: match[2], version: match[3] });
  }

  return deps;
}
