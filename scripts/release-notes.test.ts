import assert from "node:assert/strict";
import test from "node:test";
import { renderReleaseNotes } from "./release-notes.ts";

test("renders complete bilingual installation notes with exact artifact names", () => {
  const notes = renderReleaseNotes({
    version: "1.2.3",
    changesZh: "- 增加正式安装器。",
    changesEn: "- Added product installers.",
  });

  for (const expected of [
    "Cinba-1.2.3-windows-x64.exe",
    "Cinba-1.2.3-macos-arm64.dmg",
    "Cinba-1.2.3-linux-x64-gnu.tar.gz",
    "## Windows 安装",
    "## Install on Windows",
    "SmartScreen",
    "Gatekeeper",
    'xattr -dr com.apple.quarantine "$HOME/Applications/Cinba.app"',
    "https://github.com/SounDoer/Cinba/releases/download/v1.2.3/install.sh",
    "cinba update",
  ]) {
    assert.match(notes, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("covers first-launch, Background and uninstall guidance in both languages", () => {
  const notes = renderReleaseNotes({
    version: "1.2.3",
    changesZh: "- 变更。",
    changesEn: "- Change.",
  });
  const [zh, en] = notes.split("\n---\n");

  for (const [section, expected] of [
    // Windows states the product baseline without a bare "10.0".
    [notes, "Windows 10 或更高版本"],
    [notes, "Windows 10 or later"],
    // Gatekeeper may block before the self-install has created ~/Applications/Cinba.app.
    [zh, "~/Applications"],
    [en, "~/Applications"],
    // The Linux installer only edits shell startup files.
    [zh, "source ~/.bashrc"],
    [en, "source ~/.bashrc"],
    // Background on Linux needs a systemd user manager and linger.
    [zh, "sudo loginctl enable-linger $USER"],
    [en, "sudo loginctl enable-linger $USER"],
    // Uninstall entries on every platform, with purge kept explicit.
    [zh, "## 卸载"],
    [en, "## Uninstall"],
    [zh, "cinba uninstall --purge"],
    [en, "cinba uninstall --purge"],
    [zh, "/uninstall"],
    [en, "/uninstall"],
  ] as const) {
    assert.ok(section?.includes(expected), `missing ${JSON.stringify(expected)}`);
  }
  assert.doesNotMatch(notes, /Windows 10\.0/);
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
