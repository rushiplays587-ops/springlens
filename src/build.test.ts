import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRepoModel } from "./build.js";
import { assessDependencies, parsePomDependencies } from "./depscan.js";

const fixturePath = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "test-fixture"
);

test("finds all four Spring-annotated classes in the fixture, correctly classified", () => {
  const model = buildRepoModel(fixturePath);
  const names = model.classes.map((c) => c.name).sort();
  assert.deepEqual(names, ["User", "UserController", "UserRepository", "UserService"]);

  const byName = new Map(model.classes.map((c) => [c.name, c]));
  assert.equal(byName.get("UserController")?.kind, "controller");
  assert.equal(byName.get("UserService")?.kind, "service");
  assert.equal(byName.get("UserRepository")?.kind, "repository");
  assert.equal(byName.get("User")?.kind, "entity");
});

test("ignores annotation-shaped text inside comments", () => {
  const model = buildRepoModel(fixturePath);
  // The decoy comment in UserController.java claims a @Service and a
  // @GetMapping("/fake") that don't really exist — if the parser were
  // fooled by it, we'd see a phantom "Service"-kind class or a "/fake"
  // endpoint show up. Neither should appear anywhere in the model.
  const allEndpointPaths = model.classes.flatMap((c) => c.endpoints.map((e) => e.path));
  assert.ok(!allEndpointPaths.includes("/fake"));

  const controllerCount = model.classes.filter((c) => c.kind === "controller").length;
  assert.equal(controllerCount, 1); // only the real UserController, not a decoy
});

test("resolves constructor-injected dependencies, both explicit @Autowired and implicit", () => {
  const model = buildRepoModel(fixturePath);
  const byName = new Map(model.classes.map((c) => [c.name, c]));

  // UserController's constructor is explicitly @Autowired.
  assert.deepEqual(byName.get("UserController")?.dependsOn, ["UserService"]);
  // UserService's constructor has no annotation at all — implicit autowiring
  // on a class's sole constructor is still real Spring behavior and must
  // still be picked up.
  assert.deepEqual(byName.get("UserService")?.dependsOn, ["UserRepository"]);
});

test("extracts controller endpoints with HTTP method, path, and method name", () => {
  const model = buildRepoModel(fixturePath);
  const controller = model.classes.find((c) => c.name === "UserController");
  assert.ok(controller);

  const getEndpoint = controller!.endpoints.find((e) => e.methodName === "getUser");
  // The class-level @RequestMapping("/api/users") prefix must be joined in.
  assert.deepEqual(getEndpoint, {
    httpMethod: "GET",
    path: "/api/users/{id}",
    methodName: "getUser",
  });

  const postEndpoint = controller!.endpoints.find((e) => e.methodName === "createUser");
  assert.equal(postEndpoint?.httpMethod, "POST");
  assert.equal(postEndpoint?.path, "/api/users");
});

test("scans the fixture's pom.xml and flags its planted risky dependencies", () => {
  const model = buildRepoModel(fixturePath);

  // The fixture's dependencyManagement pins an ancient log4j-core (1.2.17)
  // that is NOT actually declared as a used dependency — it must not appear
  // in the parsed dependency list at all, let alone as a finding.
  assert.ok(!model.dependencies.some((d) => d.version === "1.2.17"));

  assert.equal(model.riskFindings.length, 2);
  assert.equal(
    model.riskFindings.find((f) => f.dependency.artifactId === "log4j-core")?.severity,
    "critical"
  );
  assert.equal(
    model.riskFindings.find((f) => f.dependency.artifactId === "spring-boot-starter-parent")
      ?.severity,
    "advisory"
  );
});

test("multi-module: a version pinned in the root pom's dependencyManagement applies to a module's versionless dependency", () => {
  const root = mkdtempSync(join(tmpdir(), "springlens-mm-"));
  try {
    writeFileSync(
      join(root, "pom.xml"),
      `<project><groupId>x</groupId><artifactId>root</artifactId><modules><module>api</module></modules>
       <properties><log4j.version>2.14.1</log4j.version></properties>
       <dependencyManagement><dependencies><dependency>
         <groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId><version>\${log4j.version}</version>
       </dependency></dependencies></dependencyManagement></project>`
    );
    mkdirSync(join(root, "api"));
    writeFileSync(
      join(root, "api", "pom.xml"),
      `<project><parent><groupId>x</groupId><artifactId>root</artifactId><version>1</version></parent>
       <dependencies><dependency>
         <groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId>
       </dependency></dependencies></project>`
    );
    const model = buildRepoModel(root);
    const finding = model.riskFindings.find((f) => f.dependency.artifactId === "log4j-core");
    assert.equal(finding?.severity, "critical");
    assert.equal(finding?.dependency.version, "2.14.1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("multi-module: a module inherits from a sibling parent module named by <relativePath>, not from the aggregator", () => {
  const root = mkdtempSync(join(tmpdir(), "springlens-mm2-"));
  try {
    writeFileSync(join(root, "pom.xml"), `<project><groupId>x</groupId><artifactId>aggr</artifactId><modules><module>parent</module><module>app</module></modules>
      <dependencyManagement><dependencies><dependency><groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId><version>2.20.0</version></dependency></dependencies></dependencyManagement></project>`);
    mkdirSync(join(root, "parent"));
    mkdirSync(join(root, "app"));
    writeFileSync(
      join(root, "parent", "pom.xml"),
      `<project><groupId>x</groupId><artifactId>parent</artifactId><dependencyManagement><dependencies><dependency>
         <groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId><version>2.14.1</version>
       </dependency></dependencies></dependencyManagement></project>`
    );
    writeFileSync(
      join(root, "app", "pom.xml"),
      `<project><parent><groupId>x</groupId><artifactId>parent</artifactId><version>1</version>
         <relativePath>../parent/pom.xml</relativePath></parent>
       <dependencies><dependency>
         <groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId>
       </dependency></dependencies></project>`
    );
    const finding = buildRepoModel(root).riskFindings.find((f) => f.dependency.artifactId === "log4j-core");
    assert.equal(finding?.severity, "critical");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("multi-module: a child that overrides the version property changes the inherited pin (2.17.2 is safe)", () => {
  const root = mkdtempSync(join(tmpdir(), "springlens-mm3-"));
  try {
    writeFileSync(
      join(root, "pom.xml"),
      `<project><groupId>x</groupId><artifactId>root</artifactId><modules><module>app</module></modules>
       <properties><log4j.version>2.14.1</log4j.version></properties>
       <dependencyManagement><dependencies><dependency>
         <groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId><version>\${log4j.version}</version>
       </dependency></dependencies></dependencyManagement></project>`
    );
    mkdirSync(join(root, "app"));
    writeFileSync(
      join(root, "app", "pom.xml"),
      `<project><parent><groupId>x</groupId><artifactId>root</artifactId><version>1</version></parent>
       <properties><log4j.version>2.17.2</log4j.version></properties>
       <dependencies><dependency>
         <groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId>
       </dependency></dependencies></project>`
    );
    const model = buildRepoModel(root);
    assert.equal(model.dependencies.find((d) => d.artifactId === "log4j-core")?.version, "2.17.2");
    assert.equal(model.riskFindings.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


const LOG4J = "<groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId>";

function withRepo(fn: (root: string, write: (rel: string, content: string) => void) => void): void {
  const root = mkdtempSync(join(tmpdir(), "springlens-mmx-"));
  try {
    fn(root, (rel, content) => {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), content);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("multi-module: a parent found at ../pom.xml whose coordinates differ from <parent> is not inherited from", () => {
  withRepo((root, write) => {
    write("pom.xml", `<project><groupId>x</groupId><artifactId>aggregator</artifactId><modules><module>m</module></modules>
      <dependencyManagement><dependencies><dependency>${LOG4J}<version>2.14.0</version></dependency></dependencies></dependencyManagement></project>`);
    write("m/pom.xml", `<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.3.0</version></parent>
      <dependencies><dependency>${LOG4J}</dependency></dependencies></project>`);
    const model = buildRepoModel(root);
    assert.equal(model.dependencies.find((d) => d.artifactId === "log4j-core")?.version, null);
    assert.equal(model.riskFindings.filter((f) => f.dependency.artifactId === "log4j-core").length, 0);
  });
});

test("multi-module: a parent reached only through <relativePath> contributes its own <dependencies> too", () => {
  withRepo((root, write) => {
    write("pom.xml", `<project><modules><module>m</module></modules></project>`);
    write("par/pom.xml", `<project><groupId>x</groupId><artifactId>par</artifactId>
      <dependencies><dependency>${LOG4J}<version>2.14.0</version></dependency></dependencies></project>`);
    write("m/pom.xml", `<project><parent><groupId>x</groupId><artifactId>par</artifactId><version>1</version>
      <relativePath>../par/pom.xml</relativePath></parent></project>`);
    const model = buildRepoModel(root);
    assert.equal(model.riskFindings.find((f) => f.dependency.artifactId === "log4j-core")?.severity, "critical");
    assert.ok(model.buildFiles.includes("par/pom.xml"));
  });
});

test("multi-module: <modules> inside a <profile> are not followed, the project's own are", () => {
  withRepo((root, write) => {
    write("pom.xml", `<project><profiles><profile><modules><module>p</module></modules></profile></profiles>
      <modules><module>m</module></modules></project>`);
    write("p/pom.xml", `<project><dependencies><dependency><groupId>g</groupId><artifactId>from-profile</artifactId><version>1</version></dependency></dependencies></project>`);
    write("m/pom.xml", `<project><dependencies><dependency><groupId>g</groupId><artifactId>from-module</artifactId><version>1</version></dependency></dependencies></project>`);
    const names = buildRepoModel(root).dependencies.map((d) => d.artifactId);
    assert.deepEqual(names, ["from-module"]);
  });
});

test("multi-module: parent cycles and a self-parent terminate, and the result does not depend on module order", () => {
  const layout = (order: string[]) => {
    let versions: string[] = [];
    withRepo((root, write) => {
      write("pom.xml", `<project><modules>${order.map((m) => `<module>${m}</module>`).join("")}</modules></project>`);
      write("a/pom.xml", `<project><groupId>x</groupId><artifactId>a</artifactId>
        <parent><groupId>x</groupId><artifactId>b</artifactId><version>1</version><relativePath>../b/pom.xml</relativePath></parent>
        <dependencies><dependency>${LOG4J}</dependency></dependencies></project>`);
      write("b/pom.xml", `<project><groupId>x</groupId><artifactId>b</artifactId>
        <parent><groupId>x</groupId><artifactId>a</artifactId><version>1</version><relativePath>../a/pom.xml</relativePath></parent>
        <dependencyManagement><dependencies><dependency>${LOG4J}<version>2.14.0</version></dependency></dependencies></dependencyManagement></project>`);
      write("s/pom.xml", `<project><groupId>x</groupId><artifactId>s</artifactId>
        <parent><groupId>x</groupId><artifactId>s</artifactId><version>1</version><relativePath>pom.xml</relativePath></parent></project>`);
      versions = buildRepoModel(root).dependencies.map((d) => String(d.version)).sort();
    });
    return versions;
  };
  assert.deepEqual(layout(["a", "b", "s"]), layout(["s", "b", "a"]));
});

test("multi-module: modules nest to MAX_MODULE_DEPTH (10) and no further", () => {
  withRepo((root, write) => {
    let dir = "";
    for (let level = 0; level <= 12; level++) {
      const next = `m${level + 1}`;
      write(`${dir}pom.xml`, `<project><modules><module>${next}</module></modules>
        <dependencies><dependency><groupId>g</groupId><artifactId>level-${level}</artifactId><version>1</version></dependency></dependencies></project>`);
      dir += `${next}/`;
    }
    const names = buildRepoModel(root).dependencies.map((d) => d.artifactId);
    assert.ok(names.includes("level-10"));
    assert.ok(!names.includes("level-11"));
  });
});

test("multi-module: a module directory whose name starts with two dots is still inside the repo", () => {
  withRepo((root, write) => {
    write("pom.xml", `<project><modules><module>..foo</module></modules></project>`);
    write("..foo/pom.xml", `<project><dependencies><dependency><groupId>g</groupId><artifactId>dotted</artifactId><version>1</version></dependency></dependencies></project>`);
    assert.deepEqual(buildRepoModel(root).dependencies.map((d) => d.artifactId), ["dotted"]);
  });
});

test("multi-module: a <parent> pointing at a real pom outside the repo is ignored (tests the guard, not a missing file)", () => {
  const outer = mkdtempSync(join(tmpdir(), "springlens-outer-"));
  try {
    const repo = join(outer, "repo");
    mkdirSync(join(outer, "elsewhere"));
    mkdirSync(join(repo, "b"), { recursive: true });
    writeFileSync(
      join(outer, "elsewhere", "pom.xml"),
      `<project><groupId>x</groupId><artifactId>elsewhere</artifactId>
       <dependencyManagement><dependencies><dependency><groupId>g</groupId><artifactId>lib2</artifactId><version>1.0</version></dependency></dependencies></dependencyManagement></project>`
    );
    writeFileSync(join(repo, "pom.xml"), `<project><modules><module>b</module></modules></project>`);
    writeFileSync(
      join(repo, "b", "pom.xml"),
      `<project><parent><groupId>x</groupId><artifactId>elsewhere</artifactId><version>1</version><relativePath>../../elsewhere/pom.xml</relativePath></parent>
       <dependencies><dependency><groupId>g</groupId><artifactId>lib2</artifactId></dependency></dependencies></project>`
    );
    assert.equal(buildRepoModel(repo).dependencies.find((d) => d.artifactId === "lib2")?.version, null);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("multi-module: a module reachable by a short and a long path is scanned whichever is listed first", () => {
  const scan = (order: string[]) => {
    let names: string[] = [];
    withRepo((root, write) => {
      write("pom.xml", `<project><modules>${order.map((m) => `<module>${m}</module>`).join("")}</modules></project>`);
      for (let i = 1; i <= 9; i++) {
        write(`c${i}/pom.xml`, `<project><modules><module>${i < 9 ? `../c${i + 1}` : "../x"}</module></modules></project>`);
      }
      write("x/pom.xml", `<project><modules><module>../y</module></modules></project>`);
      write("y/pom.xml", `<project><dependencies><dependency>${LOG4J}<version>2.14.0</version></dependency></dependencies></project>`);
      names = buildRepoModel(root).riskFindings.map((f) => f.dependency.artifactId);
    });
    return names;
  };
  assert.deepEqual(scan(["c1", "x"]), ["log4j-core"]);
  assert.deepEqual(scan(["x", "c1"]), ["log4j-core"]);
});

test("multi-module: <module> may name a pom file, and a directory called pom.xml does not crash the scan", () => {
  withRepo((root, write) => {
    write("pom.xml", `<project><modules><module>sub/pom-lib.xml</module><module>weird</module></modules></project>`);
    write("sub/pom-lib.xml", `<project><dependencies><dependency><groupId>g</groupId><artifactId>named-file</artifactId><version>1</version></dependency></dependencies></project>`);
    write("weird/pom.xml/keep.txt", "not a pom");
    assert.deepEqual(buildRepoModel(root).dependencies.map((d) => d.artifactId), ["named-file"]);
  });
});

test("a </build> inside CDATA does not end <build> stripping early, and <reporting> plugin dependencies are ignored", () => {
  const xml = `<project>
    <build><plugins><plugin><configuration><![CDATA[ </build> ]]></configuration>
      <dependencies><dependency>${LOG4J}<version>2.14.0</version></dependency></dependencies></plugin></plugins></build>
    <reporting><plugins><plugin><dependencies><dependency><groupId>g</groupId><artifactId>report-only</artifactId><version>1</version></dependency></dependencies></plugin></plugins></reporting>
    <dependencies><dependency><groupId>g</groupId><artifactId>real</artifactId><version>1</version></dependency></dependencies>
  </project>`;
  assert.deepEqual(parsePomDependencies(xml).map((d) => d.artifactId), ["real"]);
});

test("a dependency with <exclusions> before its <groupId> is not mistaken for the excluded artifact (no false log4j finding)", () => {
  const xml = `<project><dependencies><dependency>
    <exclusions><exclusion>${LOG4J}</exclusion></exclusions>
    <groupId>org.foo</groupId><artifactId>foo</artifactId><version>1.0</version>
  </dependency></dependencies></project>`;
  const deps = parsePomDependencies(xml);
  assert.deepEqual(deps.map((d) => `${d.artifactId}:${d.version}`), ["foo:1.0"]);
  assert.equal(assessDependencies(deps).length, 0);
});

test("configs: application/bootstrap files are found in every module, src/test and build output are skipped, names are repo-relative", () => {
  withRepo((root, write) => {
    write("pom.xml", "<project/>");
    write("a/src/main/resources/application.yml", "spring:\n  application:\n    name: a\nserver:\n  port: 1\n");
    write("b/src/main/resources/application-dev.properties", "server.port=2\n");
    write("b/src/main/resources/bootstrap.yaml", "spring:\n  cloud:\n    config:\n      uri: http://cfg\n");
    write("a/src/test/resources/application-test.yml", "server:\n  port: 3\n");
    write("a/target/classes/application.yml", "server:\n  port: 4\n");
    write("a/src/main/resources/application.yml.bak", "server:\n  port: 5\n");
    const files = buildRepoModel(root).configs.map((c) => c.file).sort();
    assert.deepEqual(files, [
      "a/src/main/resources/application.yml",
      "b/src/main/resources/application-dev.properties",
      "b/src/main/resources/bootstrap.yaml",
    ]);
  });
});

test("configs: an unparsable file is listed with an error and the rest of the scan continues", () => {
  withRepo((root, write) => {
    write("src/main/resources/application.yml", "a: [1, 2\n");
    write("src/main/resources/application-good.yml", "server:\n  port: 9\n");
    write("src/main/java/com/x/S.java", "package com.x;\n@org.springframework.stereotype.Service\npublic class S {}\n");
    const model = buildRepoModel(root);
    const bad = model.configs.find((c) => c.file.endsWith("application.yml"));
    assert.ok(bad?.error);
    assert.equal(model.configs.find((c) => c.file.endsWith("application-good.yml"))?.documents[0].summary.port, "9");
    assert.equal(model.classes.length, 1);
  });
});

test("configs: an oversized file is skipped without being parsed, and a directory named application.yml does not crash", () => {
  withRepo((root, write) => {
    write("src/main/resources/application.yml", "a: " + "x".repeat(300 * 1024));
    write("src/main/resources/application.properties/keep.txt", "not a file");
    const model = buildRepoModel(root);
    assert.equal(model.configs.length, 1);
    assert.match(model.configs[0].error ?? "", /larger than/);
  });
});

test("configs: secrets in config files never appear anywhere in the model", () => {
  const model = buildRepoModel(resolve(fixturePath, "..", "test-fixture-large"));
  const dump = JSON.stringify(model);
  for (const fake of [
    "FAKE-DB-PASSWORD-hunter2",
    "FAKE-QUERY-PASSWORD-1",
    "FAKE-CFG-PASSWORD",
    "FAKE-JWT-SECRET-abc123",
    "FAKE-WEBHOOK-TOKEN-1",
    "AKIAABCDEFGHIJKLMNOP",
    "FAKE-H2-PASSWORD",
    "FAKE-BOOTSTRAP-PASSWORD",
  ]) {
    assert.ok(!dump.includes(fake), `${fake} is in the repo model`);
  }
  assert.ok(model.configs.length >= 3);
});

test("bindings: @Value keys and @ConfigurationProperties prefixes of the larger fixture are attached to their classes", () => {
  const model = buildRepoModel(resolve(fixturePath, "..", "test-fixture-large"));
  const notify = model.classes.find((c) => c.name === "NotificationService");
  assert.deepEqual(
    notify?.configKeys?.map((k) => [k.key, k.hasDefault]),
    [["notify.webhook", false], ["notify.timeout-seconds", true], ["notify.retries", true], ["missing.setting", false]]
  );
  assert.equal(model.classes.find((c) => c.name === "ShopProperties")?.configPrefix, "shop");
});
