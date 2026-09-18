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

  return `# Cinba ${version}

## 本版变更

${changesZh}

## Windows 安装

系统要求：Windows ${windowsMinimum.version} 或更高版本（x64）。下载 \`${windowsArtifact}\` 并运行。Cinba 未进行代码签名；若 Windows SmartScreen 阻止启动，请先确认文件来自本 Release，再选择“更多信息”→“仍要运行”。安装仅作用于当前用户，不需要管理员权限。

## macOS 安装

系统要求：macOS ${macosMinimum.version} 或更高版本（Apple Silicon）。下载并打开 \`${macosArtifact}\`，运行其中的 Cinba 安装器。Cinba 未进行代码签名或 notarization；若 Gatekeeper 阻止启动，请先确认文件来自本 Release，再执行：

\`\`\`sh
xattr -dr com.apple.quarantine "$HOME/Applications/Cinba.app"
\`\`\`

## Linux Headless 安装

系统要求：Linux x86_64、kernel ${linuxMinimum.kernel} 或更高版本、glibc ${linuxMinimum.glibc} 或更高版本。推荐安装方式：

\`\`\`sh
curl -fsSL https://github.com/SounDoer/Cinba/releases/download/v${version}/install.sh | sh
\`\`\`

离线或手工安装时，下载 \`${linuxArtifact}\` 与 \`SHA256SUMS\`，核对校验值后解压，并运行包内的 \`install.sh\`。不要以 root 身份安装。

## 已有安装更新

Desktop 与 TUI 会提示可用更新，也可以运行 \`cinba update\` 立即检查、下载并确认安装。

---

## What's changed

${changesEn}

## Install on Windows

Requires Windows ${windowsMinimum.version} or later on x64. Download and run \`${windowsArtifact}\`. Cinba is unsigned. If Windows SmartScreen blocks it, first verify that the file came from this Release, then choose **More info** → **Run anyway**. Installation is per-user and does not require administrator privileges.

## Install on macOS

Requires macOS ${macosMinimum.version} or later on Apple Silicon. Download and open \`${macosArtifact}\`, then run the Cinba installer inside it. Cinba is neither code-signed nor notarized. If Gatekeeper blocks it, first verify that the file came from this Release, then run:

\`\`\`sh
xattr -dr com.apple.quarantine "$HOME/Applications/Cinba.app"
\`\`\`

## Install on Linux Headless

Requires Linux x86_64 with kernel ${linuxMinimum.kernel} or later and glibc ${linuxMinimum.glibc} or later. Recommended installation:

\`\`\`sh
curl -fsSL https://github.com/SounDoer/Cinba/releases/download/v${version}/install.sh | sh
\`\`\`

For an offline or manual installation, download \`${linuxArtifact}\` and \`SHA256SUMS\`, verify the checksum, extract the archive, and run the bundled \`install.sh\`. Do not install as root.

## Update an existing installation

Desktop and TUI notify you when an update is available. You can also run \`cinba update\` to check immediately, download it, and confirm installation.
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
