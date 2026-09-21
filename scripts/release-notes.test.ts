import assert from "node:assert/strict";
import test from "node:test";
import { renderReleaseNotes } from "./release-notes.ts";

test("renders bilingual installation notes with exact artifact names", () => {
  const notes = renderReleaseNotes({
    version: "1.2.3",
    changesZh: "- 增加正式安装器。",
    changesEn: "- Added product installers.",
  });

  for (const expected of [
    "Cinba-1.2.3-windows-x64.exe",
    "Cinba-1.2.3-macos-arm64.dmg",
    "Cinba-1.2.3-linux-x64-gnu.tar.gz",
    "## 安装",
    "## Install",
    "SmartScreen",
    "Gatekeeper",
    'xattr -dr com.apple.quarantine "$HOME/Applications/Cinba.app"',
    "https://github.com/SounDoer/Cinba/releases/download/v1.2.3/install.sh",
    "cinba update",
  ]) {
    assert.match(notes, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("starts with changes instead of repeating the GitHub release title", () => {
  const notes = renderReleaseNotes({
    version: "1.2.3",
    changesZh: "- 变更。",
    changesEn: "- Change.",
  });

  assert.ok(notes.startsWith("## 本版变更\n"));
  assert.doesNotMatch(notes, /^# Cinba 1\.2\.3/m);
});

test("states the platform baselines and the blocked-launch fallbacks", () => {
  const notes = renderReleaseNotes({
    version: "1.2.3",
    changesZh: "- 变更。",
    changesEn: "- Change.",
  });
  const [zh, en] = notes.split("\n---\n");

  for (const [section, expected] of [
    // Users know the Windows baseline as 10, not as the 10.0 NT version.
    [notes, "Windows 10"],
    [notes, "macOS 13.5"],
    [notes, "glibc 2.28"],
    // An unsigned build is allowed through the Settings pane, which is where macOS sends users.
    [zh, "隐私与安全性"],
    [en, "Privacy & Security"],
    // The offline path still needs the checksum file.
    [zh, "SHA256SUMS"],
    [en, "SHA256SUMS"],
  ] as const) {
    assert.ok(section?.includes(expected), `missing ${JSON.stringify(expected)}`);
  }
  assert.doesNotMatch(notes, /Windows 10\.0/);
});

test("stays short enough to read before installing", () => {
  const notes = renderReleaseNotes({
    version: "1.2.3",
    changesZh: "- 变更。",
    changesEn: "- Change.",
  });
  // Release notes exist to get someone installed; details belong in the repository documentation.
  assert.ok(
    notes.split("\n").length < 60,
    `release notes grew to ${notes.split("\n").length} lines`,
  );
  for (const dropped of ["## 卸载", "## Uninstall", "linger", "source ~/.bashrc"]) {
    assert.ok(!notes.includes(dropped), `release notes should not cover ${dropped}`);
  }
});

test("refuses incomplete or unstable release note input", () => {
  assert.throws(
    () => renderReleaseNotes({ version: "1.2.3-beta.1", changesZh: "变更", changesEn: "Change" }),
    /stable SemVer/,
  );
  assert.throws(
    () => renderReleaseNotes({ version: "1.2.3", changesZh: "", changesEn: "Change" }),
    /Chinese release changes/,
  );
  assert.throws(
    () => renderReleaseNotes({ version: "1.2.3", changesZh: "变更", changesEn: "  " }),
    /English release changes/,
  );
});
