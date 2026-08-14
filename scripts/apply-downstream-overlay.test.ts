// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

test("applies a verified downstream patch to a release source tree", () => {
  const root = mkdtempSync(join(tmpdir(), "t3-downstream-overlay-"));
  const overlayDir = join(root, "overlay");
  const manifestPath = join(overlayDir, "overlay.json");
  const patchPath = join(overlayDir, "overlay.patch");

  mkdirSync(overlayDir, { recursive: true });
  const createSource = (name: string) => {
    const sourceDir = join(root, name);
    mkdirSync(sourceDir, { recursive: true });
    execFileSync("git", ["-C", sourceDir, "init", "-q"]);
    execFileSync("git", ["-C", sourceDir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", sourceDir, "config", "user.name", "Overlay Test"]);
    execFileSync("git", [
      "-C",
      sourceDir,
      "remote",
      "add",
      "upstream",
      "https://github.com/pingdotgg/t3code.git",
    ]);
    writeFileSync(join(sourceDir, "hello.txt"), "hello upstream\n");
    execFileSync("git", ["-C", sourceDir, "add", "hello.txt"]);
    execFileSync("git", ["-C", sourceDir, "commit", "-q", "-m", "upstream"]);
    const commit = execFileSync("git", ["-C", sourceDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    return { sourceDir, commit };
  };

  const source = createSource("source");
  const patch = [
    "diff --git a/hello.txt b/hello.txt",
    "index 802992c..ce01362 100644",
    "--- a/hello.txt",
    "+++ b/hello.txt",
    "@@ -1 +1 @@",
    "-hello upstream",
    "+hello downstream",
    "",
  ].join("\n");
  writeFileSync(patchPath, patch);
  writeFileSync(
    manifestPath,
    JSON.stringify({
      upstreamRepository: "pingdotgg/t3code",
      upstreamRef: "v0.0.33",
      upstreamCommit: source.commit,
      patch: "overlay.patch",
      patchSha256: createHash("sha256").update(patch).digest("hex"),
    }),
  );

  execFileSync("bash", [
    fileURLToPath(new URL("./apply-downstream-overlay.sh", import.meta.url)),
    "--manifest",
    manifestPath,
    "--source-dir",
    source.sourceDir,
    "--apply",
  ]);

  expect(readFileSync(join(source.sourceDir, "hello.txt"), "utf8")).toBe("hello downstream\n");

  const wrongCommit = createSource("wrong-commit");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      upstreamRepository: "pingdotgg/t3code",
      upstreamRef: "v0.0.33",
      upstreamCommit: "0".repeat(40),
      patch: "overlay.patch",
      patchSha256: createHash("sha256").update(patch).digest("hex"),
    }),
  );
  expect(() =>
    execFileSync("bash", [
      fileURLToPath(new URL("./apply-downstream-overlay.sh", import.meta.url)),
      "--manifest",
      manifestPath,
      "--source-dir",
      wrongCommit.sourceDir,
    ]),
  ).toThrow();

  const wrongRepository = createSource("wrong-repository");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      upstreamRepository: "someone/else",
      upstreamRef: "v0.0.33",
      upstreamCommit: wrongRepository.commit,
      patch: "overlay.patch",
      patchSha256: createHash("sha256").update(patch).digest("hex"),
    }),
  );
  expect(() =>
    execFileSync("bash", [
      fileURLToPath(new URL("./apply-downstream-overlay.sh", import.meta.url)),
      "--manifest",
      manifestPath,
      "--source-dir",
      wrongRepository.sourceDir,
    ]),
  ).toThrow();
});
