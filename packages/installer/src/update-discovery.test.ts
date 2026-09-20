import assert from "node:assert/strict";
import { once } from "node:events";
import { type AddressInfo, createServer } from "node:net";
import test from "node:test";
import {
  CINBA_RELEASE_API,
  UPDATE_DISCOVERY_FAILURE_CODE,
  type UpdateDiscovery,
  UpdateDiscoveryFailureError,
  discoverCinbaUpdate,
  parseUpdateDiscoveryFailure,
  parseUpdateRateLimit,
} from "./update-discovery.ts";

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
    builtAt: "2026-09-18T01:02:03Z",
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
    published_at: "2026-09-18T01:02:03Z",
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

test("an unreachable GitHub Releases names the check and the network cause", async () => {
  const lookupFailure = Object.assign(new Error("getaddrinfo ENOTFOUND api.github.com"), {
    code: "ENOTFOUND",
  });
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const closedPort = (server.address() as AddressInfo).port;
  server.close();
  await once(server, "close");
  const failures: Array<[typeof fetch, RegExp]> = [
    [
      async () => {
        throw new TypeError("fetch failed", { cause: lookupFailure });
      },
      /\(getaddrinfo ENOTFOUND api\.github\.com\)\.$/,
    ],
    // Node's own fetch, refused by a closed local port, reports the cause as ECONNREFUSED.
    [async (_input, init) => fetch(`http://127.0.0.1:${closedPort}/`, init), /ECONNREFUSED/],
  ];
  for (const [fetcher, cause] of failures) {
    await assert.rejects(
      discoverCinbaUpdate({
        currentVersion: "0.1.0",
        currentRevision: "0".repeat(40),
        target: "windows-x64",
        fetch: fetcher,
      }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /^Cinba could not reach GitHub Releases to check for updates \(/,
        );
        assert.match(error.message, cause);
        assert.ok(error.cause instanceof TypeError);
        return true;
      },
    );
  }
});

test("a manifest download that cannot connect is reported the same way", async () => {
  await assert.rejects(
    discoverCinbaUpdate({
      currentVersion: "0.1.0",
      currentRevision: "0".repeat(40),
      target: "windows-x64",
      fetch: async (input) => {
        if (String(input) === CINBA_RELEASE_API) {
          return Response.json(githubRelease());
        }
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
        });
      },
    }),
    /^Error: Cinba could not reach GitHub Releases to check for updates \(read ECONNRESET\)\.$/,
  );
});

test("a cancelled check keeps the abort error", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    discoverCinbaUpdate({
      currentVersion: "0.1.0",
      currentRevision: "0".repeat(40),
      target: "windows-x64",
      signal: controller.signal,
      fetch: async (_input, init) => {
        init?.signal?.throwIfAborted();
        return Response.json(githubRelease());
      },
    }),
    { name: "AbortError" },
  );
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
      (error) => {
        assert.ok(error instanceof UpdateDiscoveryFailureError);
        assert.equal(error.code, UPDATE_DISCOVERY_FAILURE_CODE);
        assert.equal(error.failure, "system-incompatible");
        assert.equal(error.candidate.version, "0.2.0");
        assert.equal(error.candidate.target, target);
        assert.equal(error.candidate.artifactPath, null);
        assert.equal(parseUpdateDiscoveryFailure(error)?.failure, "system-incompatible");
        assert.match(error.message, /current .* requires/i);
        return true;
      },
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
    (error) => {
      assert.ok(error instanceof UpdateDiscoveryFailureError);
      assert.equal(error.failure, "system-unverified");
      assert.equal(error.candidate.version, "0.2.0");
      assert.match(error.message, /Linux kernel 4\.18 and glibc 2\.28/);
      assert.match(error.message, /glibc unavailable/);
      return true;
    },
  );
});

test("system discovery failure guard accepts cross-realm structure and rejects spoofed fields", () => {
  const candidate = {
    version: "0.2.0",
    revision,
    target: "windows-x64",
    artifactPath: null,
    size: 101,
    sha256: digest,
    releaseUrl: "https://github.com/SounDoer/Cinba/releases/tag/v0.2.0",
  };
  const structural = {
    code: UPDATE_DISCOVERY_FAILURE_CODE,
    failure: "system-incompatible",
    candidate,
    message: "Current Windows version 6.3 requires Windows 10.0.",
  };
  const parsed = parseUpdateDiscoveryFailure(structural);
  assert.deepEqual(parsed, structural);
  assert.notEqual(parsed?.candidate, candidate);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed?.candidate), true);
  assert.equal(parseUpdateDiscoveryFailure(Object.create(structural)), undefined);
  for (const invalid of [
    { ...structural, code: "SPOOF" },
    { ...structural, unexpected: true },
    { ...structural, failure: "download-failed" },
    { ...structural, candidate: { ...candidate, artifactPath: "C:\\unsafe.exe" } },
    { ...structural, candidate: { ...candidate, unexpected: true } },
    { ...structural, message: "" },
    { ...structural, message: "x".repeat(2_049) },
    { code: UPDATE_DISCOVERY_FAILURE_CODE },
  ]) {
    assert.equal(parseUpdateDiscoveryFailure(invalid), undefined);
  }
  assert.equal(
    parseUpdateDiscoveryFailure({
      get code() {
        throw new Error("spoof getter");
      },
    }),
    undefined,
  );
  let candidateGetterReads = 0;
  assert.equal(
    parseUpdateDiscoveryFailure({
      code: UPDATE_DISCOVERY_FAILURE_CODE,
      failure: "system-incompatible",
      get candidate() {
        candidateGetterReads += 1;
        return candidate;
      },
      message: structural.message,
    }),
    undefined,
  );
  assert.equal(candidateGetterReads, 0);
  assert.doesNotThrow(() => {
    assert.equal(
      parseUpdateDiscoveryFailure(
        new Proxy(structural, {
          ownKeys: () => {
            throw new Error("proxy trap");
          },
        }),
      ),
      undefined,
    );
  });

  let candidateReads = 0;
  const changingCandidate = new Proxy(candidate, {
    get: (target, field, receiver) => {
      candidateReads += 1;
      if (field === "version") {
        return candidateReads === 1 ? "not-semver" : "99.0.0";
      }
      return Reflect.get(target, field, receiver);
    },
  });
  const proxyParsed = parseUpdateDiscoveryFailure({ ...structural, candidate: changingCandidate });
  assert.equal(proxyParsed?.candidate.version, "0.2.0");
  assert.equal(candidateReads, 0);
});

test("producer bounds probe errors without losing compatibility context", async () => {
  await assert.rejects(
    discoverCinbaUpdate({
      currentVersion: "0.1.0",
      currentRevision: "0".repeat(40),
      target: "linux-x64-gnu",
      fetch: fetchRelease(),
      probeSystem: async () => {
        throw new Error(`probe failed ${"x".repeat(5_000)}`);
      },
    }),
    (error) => {
      assert.ok(error instanceof UpdateDiscoveryFailureError);
      assert.equal(error.message.length, 2_048);
      assert.match(error.message, /^Cinba 0\.2\.0 compatibility is unknown/);
      assert.match(error.message, /Linux kernel 4\.18 and glibc 2\.28/);
      assert.equal(parseUpdateDiscoveryFailure(error)?.failure, "system-unverified");
      return true;
    },
  );
});

test("unsupported probe output is a structured unverifiable failure", async () => {
  await assert.rejects(
    discoverCinbaUpdate({
      currentVersion: "0.1.0",
      currentRevision: "0".repeat(40),
      target: "windows-x64",
      fetch: fetchRelease(),
      probeSystem: async () => undefined as never,
    }),
    (error) => {
      assert.ok(error instanceof UpdateDiscoveryFailureError);
      assert.equal(error.failure, "system-unverified");
      assert.match(error.message, /Windows 10\.0/);
      return true;
    },
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

function respondWith(status: number, headers: Record<string, string>): typeof fetch {
  return async (input) =>
    String(input) === CINBA_RELEASE_API
      ? new Response("{}", { status, headers })
      : Response.json(manifest());
}

function checkFor(fetcher: typeof fetch): Promise<UpdateDiscovery> {
  return discoverCinbaUpdate({
    currentVersion: "0.1.0",
    currentRevision: "0".repeat(40),
    target: "windows-x64",
    fetch: fetcher,
    probeSystem: async () => supportedSystems["windows-x64"],
  });
}

test("an exhausted anonymous quota explains the rate limit and when it resets", async () => {
  const resetsAt = (Math.floor(Date.now() / 1_000) + 25 * 60) * 1_000;
  await assert.rejects(
    checkFor(
      respondWith(403, {
        "x-ratelimit-limit": "60",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetsAt / 1_000),
      }),
    ),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /^GitHub is rate limiting anonymous requests from this network \(HTTP 403, 60 requests per hour\)\./,
      );
      assert.ok(error.message.includes(new Date(resetsAt).toLocaleString()));
      assert.deepEqual(parseUpdateRateLimit(error), {
        retryAfter: new Date(resetsAt).toISOString(),
      });
      return true;
    },
  );
});

test("a rate limit answered with retry-after seconds waits that long", async () => {
  const before = Date.now();
  await assert.rejects(checkFor(respondWith(429, { "retry-after": "60" })), (error) => {
    const parsed = parseUpdateRateLimit(error);
    assert.ok(parsed?.retryAfter);
    const retryAt = Date.parse(parsed.retryAfter);
    assert.ok(retryAt >= before + 60_000 && retryAt <= Date.now() + 60_000);
    assert.ok(error instanceof Error);
    assert.match(
      error.message,
      /^GitHub is rate limiting anonymous requests from this network \(HTTP 429\)\./,
    );
    return true;
  });
});

test("a rate limit without a usable reset leaves the normal check interval in charge", async () => {
  const resets: Array<Record<string, string>> = [
    { "x-ratelimit-remaining": "0" },
    { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "not-a-number" },
    { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" },
    {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1_000) + 48 * 60 * 60),
    },
  ];
  for (const headers of resets) {
    await assert.rejects(checkFor(respondWith(403, headers)), (error) => {
      assert.deepEqual(parseUpdateRateLimit(error), { retryAfter: null });
      assert.ok(error instanceof Error);
      assert.match(error.message, /Check again later\.$/);
      return true;
    });
  }
});

test("a forbidden check without rate-limit headers names the block instead", async () => {
  await assert.rejects(checkFor(respondWith(403, {})), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(
      error.message,
      "GitHub latest release was forbidden (HTTP 403); a proxy, firewall, or GitHub restriction is blocking this network.",
    );
    assert.equal(parseUpdateRateLimit(error), undefined);
    return true;
  });
});

test("a missing latest release reports that nothing is published yet", async () => {
  await assert.rejects(checkFor(respondWith(404, {})), {
    message:
      "GitHub has no published Cinba release yet (HTTP 404); the newest release may still be a draft.",
  });
});

test("a missing release manifest names the absent asset", async () => {
  await assert.rejects(
    checkFor(async (input) =>
      String(input) === CINBA_RELEASE_API
        ? Response.json(githubRelease())
        : new Response("missing", { status: 404 }),
    ),
    { message: "cinba-release.json is missing from its GitHub release (HTTP 404)." },
  );
});

test("other HTTP failures keep their plain status report", async () => {
  await assert.rejects(checkFor(respondWith(500, {})), {
    message: "GitHub latest release request failed with HTTP 500",
  });
});
