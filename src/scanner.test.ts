import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { findJavaFiles } from "./scanner.js";

function withTree(files: string[], fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "springlens-scan-"));
  try {
    for (const f of files) {
      const full = join(root, f);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, "class X {}");
    }
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const rel = (root: string, paths: string[]) =>
  paths.map((p) => relative(root, p).split("\\").join("/")).sort();

test("skips build output at the project root but scans packages named build/out/bin inside src", () => {
  withTree(
    [
      "build/Generated.java",
      "out/Generated.java",
      "target/classes/Gen.java",
      "node_modules/x/Y.java",
      "src/main/java/com/acme/build/PipelineService.java",
      "src/main/java/com/acme/out/OutService.java",
      "src/main/java/com/acme/Real.java",
    ],
    (root) => {
      assert.deepEqual(rel(root, findJavaFiles(root)), [
        "src/main/java/com/acme/Real.java",
        "src/main/java/com/acme/build/PipelineService.java",
        "src/main/java/com/acme/out/OutService.java",
      ]);
    }
  );
});

test("does not follow symbolic links", (t) => {
  withTree(["src/A.java"], (root) => {
    try {
      symlinkSync(root, join(root, "src", "loop"), "junction");
    } catch {
      t.skip("cannot create symlinks/junctions on this system");
      return;
    }
    assert.deepEqual(rel(root, findJavaFiles(root)), ["src/A.java"]);
  });
});

test("skips src/test (test-only Spring classes) but scans a package named test inside src/main", () => {
  withTree(
    [
      "svc/src/test/java/com/acme/TestConfig.java",
      "src/test/java/com/acme/OtherTestConfig.java",
      "svc/src/main/java/com/acme/test/Probe.java",
      "svc/src/main/java/com/acme/Real.java",
    ],
    (root) => {
      assert.deepEqual(rel(root, findJavaFiles(root)), [
        "svc/src/main/java/com/acme/Real.java",
        "svc/src/main/java/com/acme/test/Probe.java",
      ]);
    }
  );
});

test("a scan root that is itself named src still has its test directory scanned", () => {
  const outer = mkdtempSync(join(tmpdir(), "springlens-srcroot-"));
  try {
    const root = join(outer, "src");
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "test", "A.java"), "class A {}");
    assert.deepEqual(rel(root, findJavaFiles(root)), ["test/A.java"]);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});
