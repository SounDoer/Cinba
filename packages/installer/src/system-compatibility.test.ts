import assert from "node:assert/strict";
import test from "node:test";
import { detectCurrentSystem } from "./system-compatibility.ts";

test("detects Windows from the kernel version", async () => {
  assert.deepEqual(
    await detectCurrentSystem("windows-x64", {
      platform: "win32",
      kernelRelease: () => "10.0.22631",
    }),
    { platform: "windows", version: "10.0.22631" },
  );
});

test("detects macOS with the absolute sw_vers executable and no shell", async () => {
  const calls: unknown[] = [];
  assert.deepEqual(
    await detectCurrentSystem("macos-arm64", {
      platform: "darwin",
      runFile: async (file, arguments_) => {
        calls.push([file, arguments_]);
        return "13.5.2\n";
      },
    }),
    { platform: "macos", version: "13.5.2" },
  );
  assert.deepEqual(calls, [["/usr/bin/sw_vers", ["-productVersion"]]]);
});

test("detects Linux kernel and runtime glibc independently", async () => {
  assert.deepEqual(
    await detectCurrentSystem("linux-x64-gnu", {
      platform: "linux",
      kernelRelease: () => "6.8.0-79-generic",
      report: () => ({ header: { glibcVersionRuntime: "2.39" } }),
    }),
    { platform: "linux-gnu", kernel: "6.8.0", glibc: "2.39" },
  );
});

test("fails closed when Linux runtime glibc cannot be detected", async () => {
  await assert.rejects(
    detectCurrentSystem("linux-x64-gnu", {
      platform: "linux",
      kernelRelease: () => "6.8.0",
      report: () => ({ header: {} }),
    }),
    /runtime glibc version is unavailable/,
  );
});
