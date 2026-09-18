import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import test from "node:test";
import type { ProductTarget } from "./platform.ts";
import type { VerifiedReleaseBundle } from "./release-bundle.ts";
import { installPreparedUpdateArtifact } from "./update-installation.ts";

type Invocation = {
  executable: string;
  arguments: readonly string[];
  environment?: NodeJS.ProcessEnv;
};

const expectedSha256 = "a".repeat(64);
const expectedVersion = "0.2.0";
const expectedRevision = "b".repeat(40);
function verifiedBundle(target: ProductTarget, root = "/bundle"): VerifiedReleaseBundle {
  return {
    metadata: { version: expectedVersion, revision: expectedRevision, target },
    launcher: posix.join(root, "launcher", target === "windows-x64" ? "cinba.exe" : "cinba"),
  } as VerifiedReleaseBundle;
}
const verifiedArtifact = {
  expectedSha256,
  expectedVersion,
  expectedRevision,
  verifyArtifact: async () => undefined,
  verifyBundle: async (path: string, target: ProductTarget) => verifiedBundle(target, path),
};

function successfulRunner(invocations: Invocation[]) {
  return async (
    executable: string,
    arguments_: readonly string[],
    options?: { environment?: NodeJS.ProcessEnv },
  ) => {
    invocations.push({
      executable,
      arguments: arguments_,
      ...(options?.environment ? { environment: options.environment } : {}),
    });
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

test("Windows executes the verified NSIS artifact silently", async () => {
  const invocations: Invocation[] = [];
  const artifactPath = "C:\\Cache\\Cinba-0.2.0-windows-x64.exe";
  await installPreparedUpdateArtifact({
    target: "windows-x64",
    artifactPath,
    ...verifiedArtifact,
    run: successfulRunner(invocations),
  });
  assert.equal(invocations[0]?.executable, artifactPath);
  assert.deepEqual(invocations[0]?.arguments, ["/S"]);
  assert.equal(invocations[0]?.environment?.CINBA_EXPECTED_VERSION, expectedVersion);
  assert.equal(invocations[0]?.environment?.CINBA_EXPECTED_REVISION, expectedRevision);
  assert.equal(invocations[0]?.environment?.CINBA_EXPECTED_TARGET, "windows-x64");
});

test("Linux lists and extracts the archive before invoking its bundle launcher", async () => {
  const invocations: Invocation[] = [];
  const root = "/tmp/cinba-update";
  await installPreparedUpdateArtifact({
    target: "linux-x64-gnu",
    artifactPath: "/cache/Cinba-0.2.0-linux-x64-gnu.tar.gz",
    ...verifiedArtifact,
    makeTemporaryDirectory: async () => root,
    removeTemporaryDirectory: async () => undefined,
    run: async (executable, arguments_, options) => {
      invocations.push({
        executable,
        arguments: arguments_,
        ...(options?.environment ? { environment: options.environment } : {}),
      });
      return {
        exitCode: 0,
        stdout: arguments_[0] === "-tzf" ? "./\n./launcher/\n./launcher/cinba\n" : "",
        stderr: "",
      };
    },
  });
  assert.deepEqual(
    invocations.map(({ executable, arguments: arguments_ }) => ({
      executable,
      arguments: arguments_,
    })),
    [
      {
        executable: "tar",
        arguments: ["-tzf", "/cache/Cinba-0.2.0-linux-x64-gnu.tar.gz"],
      },
      {
        executable: "tar",
        arguments: [
          "-xzf",
          "/cache/Cinba-0.2.0-linux-x64-gnu.tar.gz",
          "-C",
          posix.join(root, "bundle"),
          "--no-same-owner",
          "--no-same-permissions",
        ],
      },
      {
        executable: posix.join(root, "bundle", "launcher", "cinba"),
        arguments: ["install"],
      },
    ],
  );
  assert.equal(invocations[2]?.environment?.CINBA_EXPECTED_TARGET, "linux-x64-gnu");
});

test("Linux rejects archive traversal before extraction", async () => {
  const invocations: Invocation[] = [];
  await assert.rejects(
    installPreparedUpdateArtifact({
      target: "linux-x64-gnu",
      artifactPath: "/cache/Cinba.tar.gz",
      ...verifiedArtifact,
      makeTemporaryDirectory: async () => "/tmp/update",
      removeTemporaryDirectory: async () => undefined,
      run: async (executable, arguments_) => {
        invocations.push({ executable, arguments: arguments_ });
        return { exitCode: 0, stdout: "../outside\n", stderr: "" };
      },
    }),
    /unsafe path/,
  );
  assert.equal(invocations.length, 1);
});

test("macOS mounts read-only, invokes the embedded bundle launcher, and detaches", async () => {
  const invocations: Invocation[] = [];
  const mountPoint = "/tmp/cinba-update/mount";
  await installPreparedUpdateArtifact({
    target: "macos-arm64",
    artifactPath: "/cache/Cinba-0.2.0-macos-arm64.dmg",
    ...verifiedArtifact,
    makeTemporaryDirectory: async () => "/tmp/cinba-update",
    removeTemporaryDirectory: async () => undefined,
    run: successfulRunner(invocations),
  });
  assert.deepEqual(
    invocations.map(({ executable, arguments: arguments_ }) => ({
      executable,
      arguments: arguments_,
    })),
    [
      {
        executable: "hdiutil",
        arguments: [
          "attach",
          "-nobrowse",
          "-readonly",
          "-mountpoint",
          mountPoint,
          "/cache/Cinba-0.2.0-macos-arm64.dmg",
        ],
      },
      {
        executable: posix.join(
          mountPoint,
          "Cinba.app",
          "Contents",
          "Resources",
          "cinba-bundle",
          "launcher",
          "cinba",
        ),
        arguments: ["install"],
      },
      { executable: "hdiutil", arguments: ["detach", mountPoint] },
    ],
  );
  assert.equal(invocations[1]?.environment?.CINBA_EXPECTED_TARGET, "macos-arm64");
});

test("macOS detaches the image while preserving the installation failure", async () => {
  const original = new Error("bundle install failed");
  const invocations: Invocation[] = [];
  await assert.rejects(
    installPreparedUpdateArtifact({
      target: "macos-arm64",
      artifactPath: "/cache/Cinba.dmg",
      ...verifiedArtifact,
      makeTemporaryDirectory: async () => "/tmp/cinba-update",
      removeTemporaryDirectory: async () => undefined,
      run: async (executable, arguments_) => {
        invocations.push({ executable, arguments: arguments_ });
        if (arguments_[0] === "install") {
          throw original;
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    }),
    (error) => error === original,
  );
  assert.deepEqual(invocations.at(-1), {
    executable: "hdiutil",
    arguments: ["detach", "/tmp/cinba-update/mount"],
  });
});

test("a non-zero child exit fails closed", async () => {
  await assert.rejects(
    installPreparedUpdateArtifact({
      target: "windows-x64",
      artifactPath: win32.resolve("cache", "Cinba.exe"),
      ...verifiedArtifact,
      run: async () => ({ exitCode: 7, stdout: "", stderr: "failed" }),
    }),
    /exited with code 7/,
  );
});

test("a child failure includes only bounded stderr", async () => {
  const secretTail = "tail-must-not-leak";
  await assert.rejects(
    installPreparedUpdateArtifact({
      target: "windows-x64",
      artifactPath: win32.resolve("cache", "Cinba.exe"),
      ...verifiedArtifact,
      run: async () => ({
        exitCode: 7,
        stdout: "",
        stderr: `useful detail ${"x".repeat(3_000)}${secretTail}`,
      }),
    }),
    (error: unknown) => {
      assert.match(String(error), /useful detail/);
      assert.doesNotMatch(String(error), new RegExp(secretTail));
      assert.ok(String(error).length < 2_200);
      return true;
    },
  );
});

test("a changed artifact is rejected before any process starts", async () => {
  let ran = false;
  await assert.rejects(
    installPreparedUpdateArtifact({
      target: "windows-x64",
      artifactPath: win32.resolve("cache", "Cinba.exe"),
      expectedVersion,
      expectedRevision,
      expectedSha256,
      verifyArtifact: async () => {
        throw new Error("prepared update artifact SHA-256 does not match");
      },
      run: async () => {
        ran = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    }),
    /SHA-256 does not match/,
  );
  assert.equal(ran, false);
});

test("a POSIX bundle verification failure never executes its launcher", async () => {
  const invocations: Invocation[] = [];
  await assert.rejects(
    installPreparedUpdateArtifact({
      target: "linux-x64-gnu",
      artifactPath: "/cache/Cinba.tar.gz",
      ...verifiedArtifact,
      verifyBundle: async () => {
        throw new Error("Cinba launcher must be a regular file");
      },
      makeTemporaryDirectory: async () => "/tmp/update",
      removeTemporaryDirectory: async () => undefined,
      run: async (executable, arguments_) => {
        invocations.push({ executable, arguments: arguments_ });
        return {
          exitCode: 0,
          stdout: arguments_[0] === "-tzf" ? "./\n./launcher/cinba\n" : "",
          stderr: "",
        };
      },
    }),
    /launcher must be a regular file/,
  );
  assert.equal(
    invocations.some(({ executable }) => executable.endsWith("/launcher/cinba")),
    false,
  );
});

test("a candidate identity mismatch never executes the bundle launcher", async () => {
  const invocations: Invocation[] = [];
  await assert.rejects(
    installPreparedUpdateArtifact({
      target: "macos-arm64",
      artifactPath: "/cache/Cinba.dmg",
      ...verifiedArtifact,
      verifyBundle: async () => ({
        ...verifiedBundle("macos-arm64"),
        metadata: {
          ...verifiedBundle("macos-arm64").metadata,
          version: "0.3.0",
        },
      }),
      makeTemporaryDirectory: async () => "/tmp/update",
      removeTemporaryDirectory: async () => undefined,
      run: async (executable, arguments_) => {
        invocations.push({ executable, arguments: arguments_ });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    }),
    /does not match the prepared update/,
  );
  assert.equal(
    invocations.some(({ executable }) => executable.endsWith("/launcher/cinba")),
    false,
  );
  assert.deepEqual(invocations.at(-1)?.arguments, ["detach", "/tmp/update/mount"]);
});
