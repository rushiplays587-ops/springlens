import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessDependencies,
  compareVersions,
  parseGradleDependencies,
  parsePomDependencies,
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
