import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessDependencies,
  compareVersions,
  parseGradleDependencies,
  parsePomDependencies,
  parsePomModules,
} from "./depscan.js";

test("compareVersions orders dotted version numbers correctly", () => {
  assert.ok(compareVersions("2.14.1", "2.17.1") < 0);
  assert.ok(compareVersions("2.17.1", "2.17.1") === 0);
  assert.ok(compareVersions("2.17.2", "2.17.1") > 0);
  assert.ok(compareVersions("3.0.0", "2.17.1") > 0);
});

test("parsePomDependencies excludes dependencyManagement entries", () => {
  const xml = `<project>
    <dependencyManagement>
      <dependencies>
        <dependency><groupId>g</groupId><artifactId>managed-only</artifactId><version>9.9.9</version></dependency>
      </dependencies>
    </dependencyManagement>
    <dependencies>
      <dependency><groupId>g</groupId><artifactId>actually-used</artifactId><version>1.0.0</version></dependency>
    </dependencies>
  </project>`;

  const deps = parsePomDependencies(xml);
  const artifactIds = deps.map((d) => d.artifactId);
  assert.ok(artifactIds.includes("actually-used"));
  assert.ok(!artifactIds.includes("managed-only"));
});

test("parsePomDependencies includes the <parent> as a dependency (Spring Boot version usually lives there)", () => {
  const xml = `<project>
    <parent>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-parent</artifactId>
      <version>2.7.18</version>
    </parent>
    <dependencies></dependencies>
  </project>`;

  const deps = parsePomDependencies(xml);
  assert.deepEqual(
    deps.find((d) => d.artifactId === "spring-boot-starter-parent"),
    { groupId: "org.springframework.boot", artifactId: "spring-boot-starter-parent", version: "2.7.18" }
  );
});

test("parsePomDependencies leaves version as null when inherited (no <version> tag)", () => {
  const xml = `<project><dependencies>
    <dependency><groupId>g</groupId><artifactId>no-version</artifactId></dependency>
  </dependencies></project>`;

  const deps = parsePomDependencies(xml);
  assert.equal(deps[0].version, null);
});

test("parseGradleDependencies handles the common single-quoted string notation", () => {
  const content = `
    dependencies {
      implementation 'org.springframework.boot:spring-boot-starter-web:2.7.18'
      testImplementation "org.junit.jupiter:junit-jupiter:5.10.0"
    }
  `;
  const deps = parseGradleDependencies(content);
  assert.equal(deps.length, 2);
  assert.deepEqual(deps[0], {
    groupId: "org.springframework.boot",
    artifactId: "spring-boot-starter-web",
    version: "2.7.18",
  });
});

test("assessDependencies flags an old log4j-core as critical and a 2.x Spring Boot parent as advisory, skips null-version deps", () => {
  const findings = assessDependencies([
    { groupId: "org.apache.logging.log4j", artifactId: "log4j-core", version: "2.14.1" },
    { groupId: "org.springframework.boot", artifactId: "spring-boot-starter-parent", version: "2.7.18" },
    { groupId: "org.springframework.boot", artifactId: "spring-boot-starter-web", version: null },
  ]);

  assert.equal(findings.length, 2);
  assert.equal(findings.find((f) => f.dependency.artifactId === "log4j-core")?.severity, "critical");
  assert.equal(
    findings.find((f) => f.dependency.artifactId === "spring-boot-starter-parent")?.severity,
    "advisory"
  );
});

test("assessDependencies does not flag a patched log4j-core or a Spring Boot 3.x parent", () => {
  const findings = assessDependencies([
    { groupId: "org.apache.logging.log4j", artifactId: "log4j-core", version: "2.17.1" },
    { groupId: "org.springframework.boot", artifactId: "spring-boot-starter-parent", version: "3.2.0" },
  ]);
  assert.equal(findings.length, 0);
});

test("an unresolvable ${property} version is an advisory to check by hand, never a false 'critical'", () => {
  const findings = assessDependencies([
    { groupId: "org.apache.logging.log4j", artifactId: "log4j-core", version: "${log4j.version}" },
    { groupId: "org.apache.logging.log4j", artifactId: "log4j-core", version: "$log4jVersion" },
  ]);
  assert.equal(findings.length, 2);
  assert.ok(findings.every((f) => f.severity === "advisory"));
});

test("pom <properties> are used to resolve ${...} versions", () => {
  const xml = `<project>
    <properties><log4j.version>2.14.1</log4j.version><fixed.version>2.20.0</fixed.version></properties>
    <dependencies>
      <dependency><groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId><version>\${log4j.version}</version></dependency>
      <dependency><groupId>org.apache.logging.log4j</groupId><artifactId>log4j-api</artifactId><version>\${fixed.version}</version></dependency>
    </dependencies></project>`;
  const deps = parsePomDependencies(xml);
  assert.equal(deps[0].version, "2.14.1");
  assert.equal(deps[1].version, "2.20.0");
  assert.equal(assessDependencies(deps)[0].severity, "critical");
});

test("log4j patched backport releases (2.12.4, 2.3.2) are not flagged; unpatched 2.12.x / 2.3.x still are", () => {
  const log4j = (version: string) => ({
    groupId: "org.apache.logging.log4j",
    artifactId: "log4j-core",
    version,
  });
  assert.equal(assessDependencies([log4j("2.12.4"), log4j("2.3.2")]).length, 0);
  assert.equal(assessDependencies([log4j("2.12.1"), log4j("2.3.1"), log4j("2.0-beta9")]).length, 3);
});

test("commented-out pom dependencies are ignored", () => {
  const xml = `<project><dependencies>
    <!-- <dependency><groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId><version>2.14.1</version></dependency> -->
    <dependency><groupId>g</groupId><artifactId>real</artifactId><version>1.0</version></dependency>
  </dependencies></project>`;
  assert.deepEqual(parsePomDependencies(xml).map((d) => d.artifactId), ["real"]);
});

test("parsePomModules lists <module> entries and ignores commented ones", () => {
  const xml = `<project><modules><module>api</module><!-- <module>old</module> --><module>core</module></modules></project>`;
  assert.deepEqual(parsePomModules(xml), ["api", "core"]);
});

test("gradle: legacy configurations, Kotlin parens, comments, plugin version", () => {
  const content = `
    plugins { id 'org.springframework.boot' version '2.3.0' }
    dependencies {
      compile 'org.apache.logging.log4j:log4j-core:2.14.1'
      testCompile("junit:junit:4.13")
      // implementation 'org.apache.logging.log4j:log4j-core:2.0'
      /* implementation 'x:y:1' */
      classpath "org.example:tool:\${toolVersion}"
    }`;
  const deps = parseGradleDependencies(content);
  const ids = deps.map((d) => d.artifactId).sort();
  assert.deepEqual(ids, ["junit", "log4j-core", "spring-boot-gradle-plugin", "tool"]);
  const findings = assessDependencies(deps);
  assert.deepEqual(findings.map((f) => f.severity).sort(), ["advisory", "critical"]);
});
