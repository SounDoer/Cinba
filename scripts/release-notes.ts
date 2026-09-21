import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_TARGET_DEFINITIONS } from "@cinba/installer";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function stableVersion(value: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error("release notes version must be a stable SemVer");
  }
  return value;
}

function releaseChanges(value: string, language: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${language} release changes must not be empty`);
  }
  return trimmed;
}

export function renderReleaseNotes(options: {
  version: string;
  changesZh: string;
  changesEn: string;
}): string {
  const version = stableVersion(options.version);
  const changesZh = releaseChanges(options.changesZh, "Chinese");
  const changesEn = releaseChanges(options.changesEn, "English");
  const windowsArtifact = `Cinba-${version}-windows-x64.exe`;
  const macosArtifact = `Cinba-${version}-macos-arm64.dmg`;
  const linuxArtifact = `Cinba-${version}-linux-x64-gnu.tar.gz`;
  const windowsMinimum = PRODUCT_TARGET_DEFINITIONS["windows-x64"].minimumSystem;
  const macosMinimum = PRODUCT_TARGET_DEFINITIONS["macos-arm64"].minimumSystem;
  const linuxMinimum = PRODUCT_TARGET_DEFINITIONS["linux-x64-gnu"].minimumSystem;
  if (
    windowsMinimum.platform !== "windows" ||
    macosMinimum.platform !== "macos" ||
    linuxMinimum.platform !== "linux-gnu"
  ) {
    throw new Error("product platform baselines are inconsistent");
  }
  // "10.0" is the NT version; users know it as Windows 10.
  const windowsVersion = windowsMinimum.version.replace(/\.0$/, "");

  return `# Cinba ${version}

## 本版变更

${changesZh}

## 安装

**Windows ${windowsVersion} 或更高版本（x64）**：下载并运行 \`${windowsArtifact}\`。Cinba 未签名，SmartScreen 阻止时选择“更多信息”→“仍要运行”。安装仅作用于当前用户，不需要管理员权限。

**macOS ${macosMinimum.version} 或更高版本（Apple Silicon）**：下载并打开 \`${macosArtifact}\`，双击其中的 Cinba，按提示安装到 \`~/Applications\`。Cinba 使用 ad-hoc 签名但未经 notarize，若 Gatekeeper 阻止首次打开，在“系统设置 → 隐私与安全性”中选择“仍要打开”，或执行：

\`\`\`sh
xattr -dr com.apple.quarantine "$HOME/Applications/Cinba.app"
\`\`\`

**Linux x86_64（kernel ${linuxMinimum.kernel} 或更高版本、glibc ${linuxMinimum.glibc} 或更高版本）**：

\`\`\`sh
curl -fsSL https://github.com/SounDoer/Cinba/releases/download/v${version}/install.sh | sh
\`\`\`

离线安装：下载 \`${linuxArtifact}\` 与 \`SHA256SUMS\`，核对校验值后解压，运行包内的 \`install.sh\`。不要以 root 身份安装。

## 更新

Desktop 与 TUI 会提示可用更新，也可以运行 \`cinba update\`。

---

## What's changed

${changesEn}

## Install

**Windows ${windowsVersion} or later (x64)**: download and run \`${windowsArtifact}\`. Cinba is unsigned; if SmartScreen blocks it, choose **More info** → **Run anyway**. Installation is per-user and needs no administrator privileges.

**macOS ${macosMinimum.version} or later (Apple Silicon)**: download and open \`${macosArtifact}\`, double-click Cinba inside it, and confirm the install into \`~/Applications\`. Cinba is ad-hoc signed but not notarized; if Gatekeeper blocks the first launch, allow it under **System Settings → Privacy & Security**, or run:

\`\`\`sh
xattr -dr com.apple.quarantine "$HOME/Applications/Cinba.app"
\`\`\`

**Linux x86_64 (kernel ${linuxMinimum.kernel} or later, glibc ${linuxMinimum.glibc} or later)**:

\`\`\`sh
curl -fsSL https://github.com/SounDoer/Cinba/releases/download/v${version}/install.sh | sh
\`\`\`

Offline: download \`${linuxArtifact}\` and \`SHA256SUMS\`, verify the checksum, extract the archive, and run the bundled \`install.sh\`. Do not install as root.

## Update

Desktop and TUI notify you when an update is available; you can also run \`cinba update\`.
`;
}

async function packageVersion(): Promise<string> {
  const value = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof value.version !== "string") {
    throw new Error("root package.json does not contain a product version");
  }
  return value.version;
}

if (import.meta.main) {
  const outputPath = resolve(
    process.argv[2] ?? resolve(REPOSITORY_ROOT, "dist", "RELEASE_NOTES.md"),
  );
  const notes = renderReleaseNotes({
    version: await packageVersion(),
    changesZh: process.env.CINBA_RELEASE_CHANGES_ZH ?? "",
    changesEn: process.env.CINBA_RELEASE_CHANGES_EN ?? "",
  });
  await writeFile(outputPath, notes);
  console.log(`[release] Built ${outputPath}`);
}
