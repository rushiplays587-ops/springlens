import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRepoModel } from "./build.js";

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
      `<project><modules><module>api</module></modules>
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
    writeFileSync(join(root, "pom.xml"), `<project><modules><module>parent</module><module>app</module></modules></project>`);
    mkdirSync(join(root, "parent"));
    mkdirSync(join(root, "app"));
    writeFileSync(
      join(root, "parent", "pom.xml"),
      `<project><dependencyManagement><dependencies><dependency>
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
      `<project><modules><module>app</module></modules>
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

test("multi-module: a module with no <parent> inherits nothing, and a parent pointing outside the repo is ignored", () => {
  const root = mkdtempSync(join(tmpdir(), "springlens-mm4-"));
  try {
    writeFileSync(
      join(root, "pom.xml"),
      `<project><modules><module>a</module><module>b</module></modules>
       <dependencyManagement><dependencies><dependency>
         <groupId>g</groupId><artifactId>lib</artifactId><version>1.0</version>
       </dependency></dependencies></dependencyManagement></project>`
    );
    mkdirSync(join(root, "a"));
    mkdirSync(join(root, "b"));
    writeFileSync(join(root, "a", "pom.xml"), `<project><dependencies><dependency><groupId>g</groupId><artifactId>lib</artifactId></dependency></dependencies></project>`);
    writeFileSync(
      join(root, "b", "pom.xml"),
      `<project><parent><relativePath>../../elsewhere/pom.xml</relativePath></parent>
       <dependencies><dependency><groupId>g</groupId><artifactId>lib</artifactId></dependency></dependencies></project>`
    );
    const libs = buildRepoModel(root).dependencies.filter((d) => d.artifactId === "lib");
    assert.deepEqual(libs.map((d) => d.version), [null]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
