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
