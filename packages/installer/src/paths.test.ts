import assert from "node:assert/strict";
import test from "node:test";
import { PRODUCT_IDENTITIES, resolveProductPaths } from "./paths.ts";

test("resolves the Windows per-user program and data boundaries", () => {
  const paths = resolveProductPaths({
    platform: "win32",
    homeDirectory: "C:\\Users\\Ada",
    environment: { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" },
  });

  assert.equal(paths.programDirectory, "C:\\Users\\Ada\\AppData\\Local\\Programs\\Cinba");
  assert.equal(paths.dataDirectory, "C:\\Users\\Ada\\AppData\\Local\\Cinba\\Data");
  assert.equal(paths.syncDataDirectory, `${paths.dataDirectory}\\Sync`);
  assert.equal(paths.launcherPath, `${paths.programDirectory}\\bin\\cinba.exe`);
  assert.equal(paths.currentPointerDirectory, paths.programDirectory);
  assert.equal(paths.applicationId, "com.soundoer.cinba");
});

test("resolves the macOS app, support, cache, log, and launcher boundaries", () => {
  const paths = resolveProductPaths({ platform: "darwin", homeDirectory: "/Users/ada" });

  assert.equal(paths.programDirectory, "/Users/ada/Applications/Cinba.app");
  assert.equal(
    paths.dataDirectory,
    "/Users/ada/Library/Application Support/com.soundoer.cinba/Data",
  );
  assert.equal(paths.cacheDirectory, "/Users/ada/Library/Caches/com.soundoer.cinba");
  assert.equal(paths.logDirectory, "/Users/ada/Library/Logs/com.soundoer.cinba");
  assert.equal(paths.launcherPath, "/Users/ada/.local/bin/cinba");
  assert.equal(
    paths.currentPointerDirectory,
    "/Users/ada/Library/Application Support/com.soundoer.cinba/Installer",
  );
  assert.notEqual(paths.currentPointerDirectory, paths.programDirectory);
});

test("resolves Linux defaults and absolute XDG overrides", () => {
  const defaults = resolveProductPaths({ platform: "linux", homeDirectory: "/home/ada" });
  assert.equal(defaults.programDirectory, "/home/ada/.local/lib/cinba");
  assert.equal(defaults.dataDirectory, "/home/ada/.local/share/cinba/data");
  assert.equal(defaults.configurationDirectory, "/home/ada/.config/cinba");
  assert.equal(defaults.stateDirectory, "/home/ada/.local/state/cinba");
  assert.equal(defaults.cacheDirectory, "/home/ada/.cache/cinba");
  assert.equal(defaults.launcherPath, "/home/ada/.local/bin/cinba");
  assert.equal(defaults.currentPointerDirectory, defaults.programDirectory);

  const overridden = resolveProductPaths({
    platform: "linux",
    homeDirectory: "/home/ada",
    environment: {
      XDG_DATA_HOME: "/data",
      XDG_CONFIG_HOME: "/config",
      XDG_STATE_HOME: "/state",
      XDG_CACHE_HOME: "/cache",
    },
  });
  assert.equal(overridden.dataDirectory, "/data/cinba/data");
  assert.equal(overridden.configurationDirectory, "/config/cinba");
  assert.equal(overridden.stateDirectory, "/state/cinba");
  assert.equal(overridden.cacheDirectory, "/cache/cinba");
});

test("rejects relative home and XDG paths", () => {
  assert.throws(
    () => resolveProductPaths({ platform: "linux", homeDirectory: "home/ada" }),
    /homeDirectory must be an absolute Linux path/,
  );
  assert.throws(
    () =>
      resolveProductPaths({
        platform: "linux",
        homeDirectory: "/home/ada",
        environment: { XDG_DATA_HOME: "relative/data" },
      }),
    /XDG_DATA_HOME must be an absolute path/,
  );
});

test("keeps release and development identities fully separate", () => {
  assert.deepEqual(PRODUCT_IDENTITIES.release, {
    displayName: "Cinba",
    applicationId: "com.soundoer.cinba",
    directoryName: "Cinba",
    slug: "cinba",
    launcherName: "cinba",
  });
  assert.equal(PRODUCT_IDENTITIES.development.displayName, "Cinba Dev");

  for (const platform of ["win32", "darwin", "linux"] as const) {
    const homeDirectory = platform === "win32" ? "C:\\Users\\Ada" : "/home/ada";
    const release = resolveProductPaths({ platform, homeDirectory, identity: "release" });
    const development = resolveProductPaths({
      platform,
      homeDirectory,
      identity: "development",
    });
    for (const key of Object.keys(release) as Array<keyof typeof release>) {
      if (key === "identity" || key === "launcherDirectory") {
        continue;
      }
      assert.notEqual(release[key], development[key], `${platform} ${key} must be isolated`);
    }
  }
});

test("keeps durable data outside versioned release storage", () => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    const paths = resolveProductPaths({
      platform,
      homeDirectory: platform === "win32" ? "C:\\Users\\Ada" : "/home/ada",
    });
    const normalizedData = paths.dataDirectory.toLowerCase();
    const normalizedReleases = paths.releasesDirectory.toLowerCase();
    assert.equal(normalizedData.startsWith(`${normalizedReleases}/`), false);
    assert.equal(normalizedData.startsWith(`${normalizedReleases}\\`), false);
    assert.ok(paths.syncDataDirectory.startsWith(paths.dataDirectory));
  }
});
