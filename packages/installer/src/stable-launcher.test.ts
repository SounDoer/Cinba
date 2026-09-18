import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  type InstallationLayout,
  type InstalledRelease,
  writeCurrentRelease,
} from "./installation-store.ts";
import { type ProductTarget, requireProductTarget } from "./platform.ts";
import { resolveInstalledProductCommand } from "./stable-launcher.ts";

const revision = "a".repeat(40);

function layout(root: string): InstallationLayout {
  return {
    programDirectory: join(root, "program"),
    releasesDirectory: join(root, "program", "releases"),
    transactionDirectory: join(root, "state", "install"),
  };
}

function installed(target: ProductTarget): InstalledRelease {
  return {
    version: "0.1.0",
    revision,
    protocolVersion: 1,
    dataFormatVersion: 1,
    target,
    directory: revision,
  };
}

test("the stable launcher follows current and preserves user arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-stable-launcher-"));
  const paths = layout(root);
  const target = requireProductTarget();
  const current = installed(target);
  const release = join(paths.releasesDirectory, revision);
  const runtime =
    target === "windows-x64"
      ? join(release, "runtime", "node.exe")
      : join(release, "runtime", "bin", "node");
  try {
    await mkdir(join(release, "lib"), { recursive: true });
    await mkdir(dirname(runtime), { recursive: true });
    await writeFile(runtime, "runtime");
    await writeFile(join(release, "lib", "cli.mjs"), "cli");
    await writeFile(
      join(release, "release.json"),
      JSON.stringify({
        schemaVersion: 1,
        product: "Cinba",
        version: current.version,
        revision: current.revision,
        protocolVersion: current.protocolVersion,
        dataFormatVersion: current.dataFormatVersion,
        target,
        nodeVersion: "24.0.0",
      }),
    );
    await writeCurrentRelease(paths, current);

    const command = await resolveInstalledProductCommand({
      layout: paths,
      target,
      arguments: ["core", "status"],
    });
    assert.equal(command.releaseDirectory, release);
    assert.equal(command.executable, runtime);
    assert.deepEqual(command.arguments, [join(release, "lib", "cli.mjs"), "core", "status"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the stable launcher fails closed when current is missing or inconsistent", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-stable-launcher-invalid-"));
  const paths = layout(root);
  const target = requireProductTarget();
  try {
    await assert.rejects(
      () => resolveInstalledProductCommand({ layout: paths, target, arguments: [] }),
      { message: "Cinba is not installed" },
    );
    const current = installed(target);
    const release = join(paths.releasesDirectory, revision);
    await mkdir(release, { recursive: true });
    await writeFile(
      join(release, "release.json"),
      JSON.stringify({
        schemaVersion: 1,
        product: "Cinba",
        ...current,
        directory: undefined,
        version: "0.2.0",
        nodeVersion: "24.0.0",
      }),
    );
    await writeCurrentRelease(paths, current);
    await assert.rejects(
      () => resolveInstalledProductCommand({ layout: paths, target, arguments: [] }),
      { message: "active release metadata does not match the installation pointer" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
