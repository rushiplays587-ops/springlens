import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNarrationPrompt } from "./narrate.js";
import { ClassInfo } from "./model.js";

function makeClass(overrides: Partial<ClassInfo> = {}): ClassInfo {
  return {
    name: "UserController",
    kind: "controller",
    file: "UserController.java",
    annotations: ["RestController", "RequestMapping"],
    endpoints: [{ httpMethod: "GET", path: "/{id}", methodName: "getUser" }],
    dependsOn: ["UserService"],
    rawBody: "public User getUser(Long id) { return userService.findById(id); }",
    ...overrides,
  };
}

test("buildNarrationPrompt includes the class name, kind, and dependencies", () => {
  const prompt = buildNarrationPrompt(makeClass());
  assert.ok(prompt.includes("UserController"));
  assert.ok(prompt.includes("controller"));
  assert.ok(prompt.includes("UserService"));
});

test("buildNarrationPrompt includes endpoint lines for controllers", () => {
  const prompt = buildNarrationPrompt(makeClass());
  assert.ok(prompt.includes("GET /{id} -> getUser()"));
});

test("buildNarrationPrompt omits the endpoints section entirely for non-controllers", () => {
  const prompt = buildNarrationPrompt(
    makeClass({ kind: "service", endpoints: [], annotations: ["Service"] })
  );
  assert.ok(!prompt.includes("Endpoints:"));
});

test("buildNarrationPrompt truncates very long class bodies rather than sending them whole", () => {
  const hugeBody = "x".repeat(10_000);
  const prompt = buildNarrationPrompt(makeClass({ rawBody: hugeBody }));
  assert.ok(prompt.includes("(truncated)"));
  assert.ok(prompt.length < hugeBody.length + 2000); // sanity: didn't just include it all anyway
});

test("buildNarrationPrompt handles a class with no dependencies and no annotations gracefully", () => {
  const prompt = buildNarrationPrompt(
    makeClass({ dependsOn: [], annotations: [], endpoints: [] })
  );
  assert.ok(prompt.includes("(nothing else in this repo)"));
  assert.ok(prompt.includes("(none)"));
});
