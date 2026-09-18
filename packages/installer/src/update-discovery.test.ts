import assert from "node:assert/strict";
import test from "node:test";
import { CINBA_RELEASE_API, discoverCinbaUpdate } from "./update-discovery.ts";

const digest = "ab".repeat(32);
const revision = "1".repeat(40);
const supportedSystems = {
  "windows-x64": { platform: "windows", version: "10.0" },
  "macos-arm64": { platform: "macos", version: "13.5" },
  "linux-x64-gnu": { platform: "linux-gnu", kernel: "4.18", glibc: "2.28" },
} as const;

function manifest(version = "0.2.0") {
  return {
    schemaVersion: 1,
    product: "Cinba",
    version,
    revision,
    protocolVersion: 1,
    dataFormatVersion: 1,
    publishedAt: "2026-09-18T01:02:03Z",
    artifacts: [
      {
        target: "windows-x64",
        fileName: `Cinba-${version}-windows-x64.exe`,
        size: 101,
        sha256: digest,
        minimumSystem: { version: "10.0" },
      },
      {
        target: "macos-arm64",
        fileName: `Cinba-${version}-macos-arm64.dmg`,
        size: 102,
        sha256: digest,
        minimumSystem: { version: "13.5" },
      },
      {
        target: "linux-x64-gnu",
        fileName: `Cinba-${version}-linux-x64-gnu.tar.gz`,
        size: 103,
        sha256: digest,
        minimumSystem: { kernel: "4.18", glibc: "2.28" },
      },
    ],
  };
}

function githubRelease(version = "0.2.0") {
  const releaseManifest = manifest(version);
  const base = `https://github.com/SounDoer/Cinba/releases/download/v${version}`;
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/SounDoer/Cinba/releases/tag/v${version}`,
    draft: false,
    prerelease: false,
    immutable: true,
    published_at: releaseManifest.publishedAt,
    assets: [
      {
        name: "cinba-release.json",
        size: 999,
        digest: null,
        browser_download_url: `${base}/cinba-release.json`,
      },
      ...releaseManifest.artifacts.map((artifact) => ({
        name: artifact.fileName,
        size: artifact.size,
        digest: `sha256:${artifact.sha256}`,
        browser_download_url: `${base}/${artifact.fileName}`,
      })),
    ],
  };
}

function fetchRelease(version = "0.2.0"): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url === CINBA_RELEASE_API) {
      return Response.json(githubRelease(version));
    }
    if (url.endsWith("/cinba-release.json")) {
      return Response.json(manifest(version));
    }
    return new Response("missing", { status: 404 });
  };
}

test("discovers one target artifact from an immutable stable Cinba release", async () => {
  const result = await discoverCinbaUpdate({
    currentVersion: "0.1.0",
    currentRevision: "0".repeat(40),
    target: "windows-x64",
    fetch: fetchRelease(),
    probeSystem: async () => supportedSystems["windows-x64"],
  });
  assert.equal(result.state, "available");
  if (result.state === "available") {
    assert.equal(result.latestVersion, "0.2.0");
    assert.equal(result.artifact.target, "windows-x64");
    assert.equal(
      result.downloadUrl,
      "https://github.com/SounDoer/Cinba/releases/download/v0.2.0/Cinba-0.2.0-windows-x64.exe",
    );
  }
});

test("release and manifest requests share the caller abort signal", async () => {
  const controller = new AbortController();
  const signals: Array<AbortSignal | null | undefined> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    signals.push(init?.signal);
    return String(input) === CINBA_RELEASE_API
      ? Response.json(githubRelease())
      : Response.json(manifest());
  };

  await discoverCinbaUpdate({
    currentVersion: "0.1.0",
    currentRevision: "0".repeat(40),
    target: "windows-x64",
    signal: controller.signal,
    fetch: fakeFetch,
    probeSystem: async () => supportedSystems["windows-x64"],
  });

  assert.deepEqual(signals, [controller.signal, controller.signal]);
});

test("a same or older immutable release leaves the installation current", async () => {
  const result = await discoverCinbaUpdate({
    currentVersion: "0.2.0",
    currentRevision: revision,
    target: "linux-x64-gnu",
    fetch: fetchRelease(),
    probeSystem: async () => supportedSystems["linux-x64-gnu"],
  });
  assert.equal(result.state, "current");
});

test("accepts each target exactly at its manifest minimum system boundary", async () => {
  for (const target of Object.keys(supportedSystems) as Array<keyof typeof supportedSystems>) {
    const result = await discoverCinbaUpdate({
      currentVersion: "0.1.0",
      currentRevision: "0".repeat(40),
      target,
      fetch: fetchRelease(),
      probeSystem: async () => supportedSystems[target],
    });
    assert.equal(result.state, "available");
  }
});

test("rejects a newer release below each target minimum system boundary", async () => {
  const systems = {
    "windows-x64": { platform: "windows", version: "6.3" },
    "macos-arm64": { platform: "macos", version: "13.4.9" },
    "linux-x64-gnu": { platform: "linux-gnu", kernel: "4.17", glibc: "2.27" },
  } as const;
  for (const target of Object.keys(systems) as Array<keyof typeof systems>) {
    await assert.rejects(
      discoverCinbaUpdate({
        currentVersion: "0.1.0",
        currentRevision: "0".repeat(40),
        target,
        fetch: fetchRelease(),
        probeSystem: async () => systems[target],
      }),
      /new Cinba version exists.*system is incompatible/i,
    );
  }
});

test("fails closed when current system compatibility cannot be verified", async () => {
  await assert.rejects(
    discoverCinbaUpdate({
      currentVersion: "0.1.0",
      currentRevision: "0".repeat(40),
      target: "linux-x64-gnu",
      fetch: fetchRelease(),
      probeSystem: async () => {
        throw new Error("glibc unavailable");
      },
    }),
    /new Cinba version exists.*compatibility is unverifiable/i,
  );
});

test("rejects prereleases, mutable releases, foreign URLs, and identity conflicts", async () => {
  for (const mutate of [
    (release: ReturnType<typeof githubRelease>) => (release.prerelease = true),
    (release: ReturnType<typeof githubRelease>) => (release.immutable = false),
    (release: ReturnType<typeof githubRelease>) =>
      (release.assets[0]!.browser_download_url = "https://example.test/cinba-release.json"),
  ]) {
    const release = githubRelease();
    mutate(release);
    const fakeFetch: typeof fetch = async (input) =>
      String(input) === CINBA_RELEASE_API ? Response.json(release) : Response.json(manifest());
    await assert.rejects(
      discoverCinbaUpdate({
        currentVersion: "0.1.0",
        currentRevision: "0".repeat(40),
        target: "windows-x64",
        fetch: fakeFetch,
        probeSystem: async () => supportedSystems["windows-x64"],
      }),
    );
  }
  await assert.rejects(
    discoverCinbaUpdate({
      currentVersion: "0.2.0",
      currentRevision: "0".repeat(40),
      target: "windows-x64",
      fetch: fetchRelease(),
      probeSystem: async () => supportedSystems["windows-x64"],
    }),
    /different revisions/,
  );
});
