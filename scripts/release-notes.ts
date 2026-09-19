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

## Windows 安装

系统要求：Windows ${windowsVersion} 或更高版本（x64）。下载 \`${windowsArtifact}\` 并运行。Cinba 未进行代码签名；若 Windows SmartScreen 阻止启动，请先确认文件来自本 Release，再选择“更多信息”→“仍要运行”。安装仅作用于当前用户，不需要管理员权限。

## macOS 安装

系统要求：macOS ${macosMinimum.version} 或更高版本（Apple Silicon）。下载并打开 \`${macosArtifact}\`，运行其中的 Cinba；首次运行会将其安装到 \`~/Applications/Cinba.app\`。Cinba 未进行代码签名或 notarization；若 Gatekeeper 阻止启动，请先确认文件来自本 Release。如果在 DMG 中首次打开时就被阻止，请先把 DMG 中的 \`Cinba.app\` 手工复制到 \`~/Applications\`（该文件夹不存在时先创建）。然后执行以下命令，再打开 \`~/Applications/Cinba.app\`：

\`\`\`sh
xattr -dr com.apple.quarantine "$HOME/Applications/Cinba.app"
\`\`\`

## Linux Headless 安装

系统要求：Linux x86_64、kernel ${linuxMinimum.kernel} 或更高版本、glibc ${linuxMinimum.glibc} 或更高版本。推荐安装方式：

\`\`\`sh
curl -fsSL https://github.com/SounDoer/Cinba/releases/download/v${version}/install.sh | sh
\`\`\`

离线或手工安装时，下载 \`${linuxArtifact}\` 与 \`SHA256SUMS\`，核对校验值后解压，并运行包内的 \`install.sh\`。不要以 root 身份安装。安装完成后重新打开 shell（或执行 \`source ~/.bashrc\`，zsh 为 \`source ~/.zshrc\`），然后运行 \`cinba\`。

若要让 Core 或 Sync 以 Background 方式在 SSH 断开和主机重启后继续运行，主机需使用 systemd，并为当前用户启用 linger：\`sudo loginctl enable-linger $USER\`。启用 Background 时 Cinba 会检查这一条件，并在交互终端中询问是否代为执行；未满足时保持 On-demand。

## 已有安装更新

Desktop 与 TUI 会提示可用更新，也可以运行 \`cinba update\` 立即检查、下载并确认安装。

## 卸载

普通卸载会删除程序，但保留会话、设置、凭据和 Sync 数据，重新安装后即可恢复。可以通过以下任一方式卸载：Windows“设置”→“应用”→“已安装的应用”；Desktop 托盘或菜单栏中的 Uninstall；TUI 中的 \`/uninstall\`；或运行 \`cinba uninstall\`。若要同时永久删除全部 Cinba 数据，请使用 Desktop 中单独的 “Uninstall and Delete All Data…” 或运行 \`cinba uninstall --purge\`，并按提示确认。此操作不可撤销，你的项目文件不会受影响。

---

## What's changed

${changesEn}

## Install on Windows

Requires Windows ${windowsVersion} or later on x64. Download and run \`${windowsArtifact}\`. Cinba is unsigned. If Windows SmartScreen blocks it, first verify that the file came from this Release, then choose **More info** → **Run anyway**. Installation is per-user and does not require administrator privileges.

## Install on macOS

Requires macOS ${macosMinimum.version} or later on Apple Silicon. Download and open \`${macosArtifact}\`, then run Cinba from it; the first run installs it to \`~/Applications/Cinba.app\`. Cinba is neither code-signed nor notarized. If Gatekeeper blocks it, first verify that the file came from this Release. If it is blocked the first time you open it from the DMG, copy \`Cinba.app\` from the DMG to \`~/Applications\` yourself (create the folder if needed). Then run the following command and open \`~/Applications/Cinba.app\`:

\`\`\`sh
xattr -dr com.apple.quarantine "$HOME/Applications/Cinba.app"
\`\`\`

## Install on Linux Headless

Requires Linux x86_64 with kernel ${linuxMinimum.kernel} or later and glibc ${linuxMinimum.glibc} or later. Recommended installation:

\`\`\`sh
curl -fsSL https://github.com/SounDoer/Cinba/releases/download/v${version}/install.sh | sh
\`\`\`

For an offline or manual installation, download \`${linuxArtifact}\` and \`SHA256SUMS\`, verify the checksum, extract the archive, and run the bundled \`install.sh\`. Do not install as root. After installation, open a new shell (or run \`source ~/.bashrc\`, or \`source ~/.zshrc\` for zsh) and run \`cinba\`.

To keep Core or Sync running in Background after SSH disconnects and host restarts, the host must use systemd and the current user needs linger: \`sudo loginctl enable-linger $USER\`. Cinba checks this when you enable Background and, in an interactive terminal, offers to run it for you. Until then it stays on-demand.

## Update an existing installation

Desktop and TUI notify you when an update is available. You can also run \`cinba update\` to check immediately, download it, and confirm installation.

## Uninstall

A regular uninstall removes the program and keeps your sessions, settings, credentials, and Sync data, so reinstalling restores them. Use any of these: Windows **Settings** → **Apps** → **Installed apps**; **Uninstall** in the Desktop tray or menu bar; \`/uninstall\` in the TUI; or \`cinba uninstall\`. To also permanently delete all Cinba data, use the separate **Uninstall and Delete All Data…** in Desktop or run \`cinba uninstall --purge\` and confirm when prompted. This cannot be undone. Your project files are not touched.
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
