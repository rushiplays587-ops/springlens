import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
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
