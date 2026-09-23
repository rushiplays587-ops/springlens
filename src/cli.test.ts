import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const cli = resolve(here, "cli.js");
const fixture = resolve(here, "..", "test-fixture-large");

// No test here may reach the network: ANTHROPIC_API_KEY is removed, or the
// run is arranged so nothing is retrieved and so nothing is sent.
function run(args: string[], extraEnv: Record<string, string> = {}) {
  const env = { ...process.env, ...extraEnv };
  if (!("ANTHROPIC_API_KEY" in extraEnv)) delete env.ANTHROPIC_API_KEY;
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: "utf-8", env });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("ask (default) prints local results, says no AI answer was generated, and writes no report", () => {
  const r = run(["ask", fixture, "where", "is", "user", "login", "handled"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes("AuthController"));
  assert.ok(r.out.includes("No AI answer was generated"));
  assert.ok(!r.out.includes("sending"));
});

test("ask --ai without ANTHROPIC_API_KEY stays local and says so", () => {
  const r = run(["ask", fixture, "which class talks to the database", "--ai"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes("ANTHROPIC_API_KEY is not set"));
  assert.ok(r.out.includes("UserRepository"));
});

test("ask --ai with a key but nothing retrieved sends nothing and says so", () => {
  const r = run(["ask", fixture, "zebra quantum", "--ai"], { ANTHROPIC_API_KEY: "sk-ant-not-a-real-key" });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes("nothing was sent"));
});

test("ask without a question or path exits 2 with usage", () => {
  assert.equal(run(["ask"]).code, 2);
  assert.equal(run(["ask", fixture]).code, 2);
  assert.ok(run(["ask", fixture]).err.includes("usage"));
});

test("ask rejects an over-long question with exit 2", () => {
  const r = run(["ask", fixture, "x".repeat(1001)]);
  assert.equal(r.code, 2);
});

test("ask on a missing path exits 1", () => {
  assert.equal(run(["ask", resolve(here, "no-such-dir"), "anything"]).code, 1);
});

test("ask rejects unknown flags", () => {
  assert.equal(run(["ask", fixture, "q", "--bogus"]).code, 2);
});

test("--help shows the ask command and its privacy behavior", () => {
  const r = run(["ask", "--help"]);
  assert.ok(r.out.includes("springlens ask"));
  assert.ok(r.out.includes("string literals"));
});

test("ask with the word 'constructor' does not crash", () => {
  const r = run(["ask", fixture, "constructor"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(!r.err.includes("unexpected error"));
});

test("ask accepts a quoted question that starts with dashes", () => {
  const r = run(["ask", fixture, "-- login"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes("AuthController"));
});

test("ask accepts a question after a bare -- even when it starts with a dash and has no spaces", () => {
  const r = run(["ask", fixture, "--", "-login"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes("AuthController"));
});

test("ask still rejects a real unknown flag before --", () => {
  assert.equal(run(["ask", fixture, "--bogus", "--", "login"]).code, 2);
});
