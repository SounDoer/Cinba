import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveProductPaths } from "../paths.ts";
import { createManagedServiceDefinitions } from "./definitions.ts";
import {
  type RunLaunchctl,
  createMacosLaunchAgentAdapter,
  renderMacosLaunchAgent,
} from "./macos-launch-agent.ts";

const paths = resolveProductPaths({ platform: "darwin", homeDirectory: "/Users/cinba" });
const core = createManagedServiceDefinitions(paths, "darwin").core;

test("macOS LaunchAgents run the stable launcher only in the logged-in user session", () => {
  const plist = renderMacosLaunchAgent(core);
  assert.match(plist, /<string>com\.soundoer\.cinba\.core<\/string>/);
  assert.match(plist, /<string>\/Users\/cinba\/\.local\/bin\/cinba<\/string>/);
  assert.match(plist, /<string>service<\/string>\s*<string>core<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(
    plist,
    /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/,
  );
  assert.doesNotMatch(plist, /Releases|UserName/);
});

test("LaunchAgent property lists XML-escape paths", () => {
  const plist = renderMacosLaunchAgent({
    ...core,
    launcherPath: "/Users/A&B/<cinba>",
  });
  assert.match(plist, /A&amp;B\/&lt;cinba&gt;/);
});

test("the adapter bootstraps, starts, stops, inspects, and removes one user agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "cinba-launch-agent-"));
  const commands: string[][] = [];
  let registered = false;
  let running = false;
  const runLaunchctl: RunLaunchctl = async (arguments_) => {
    commands.push([...arguments_]);
    if (arguments_[0] === "bootstrap") {
      registered = true;
      running = true;
    } else if (arguments_[0] === "kickstart") {
      running = true;
    } else if (arguments_[0] === "kill") {
      running = false;
    } else if (arguments_[0] === "bootout") {
      registered = false;
      running = false;
    }
    if (arguments_[0] === "print") {
      return registered
        ? { exitCode: 0, stdout: running ? "state = running\n" : "state = waiting\n", stderr: "" }
        : { exitCode: 113, stdout: "", stderr: "Could not find service" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const directory = join(root, "Library", "LaunchAgents");
  const installedCore = { ...core, logPath: join(root, "Logs", "core.log") };
  const adapter = createMacosLaunchAgentAdapter({
    userId: 501,
    launchAgentsDirectory: directory,
    runLaunchctl,
  });
  try {
    await adapter.install(installedCore);
    assert.match(
      await readFile(join(directory, "com.soundoer.cinba.core.plist"), "utf8"),
      /Logs[\\/]core\.log/,
    );
    assert.deepEqual(await adapter.inspect(installedCore), { registered: true, running: true });
    await adapter.stop(installedCore);
    assert.deepEqual(await adapter.inspect(installedCore), { registered: true, running: false });
    await adapter.start(installedCore);
    await adapter.stop(installedCore);
    await adapter.remove(installedCore);
    assert.deepEqual(await adapter.inspect(installedCore), { registered: false, running: false });
    assert.deepEqual(commands[0]?.slice(0, 2), ["bootstrap", "gui/501"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
