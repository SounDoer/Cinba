import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export type PosixPathConfiguration =
  | { state: "already-available" }
  | { state: "profile-updated"; profilePath: string }
  | { state: "manual"; instruction: string };

const START_MARKER = "# >>> Cinba CLI >>>";
const END_MARKER = "# <<< Cinba CLI <<<";
const MANAGED_BLOCK = `${START_MARKER}
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
${END_MARKER}`;

function pathEntries(value: string): string[] {
  return value.split(":").filter((entry) => entry.length > 0);
}

function profileForShell(homeDirectory: string, shell: string): string | undefined {
  const name = basename(shell);
  if (name === "bash") {
    return join(homeDirectory, ".bashrc");
  }
  if (name === "zsh") {
    return join(homeDirectory, ".zshrc");
  }
  return undefined;
}

function markerRange(content: string): { start: number; end: number } | undefined {
  const start = content.indexOf(START_MARKER);
  const end = content.indexOf(END_MARKER);
  if (start === -1 && end === -1) {
    return undefined;
  }
  if (
    start === -1 ||
    end === -1 ||
    end < start ||
    content.indexOf(START_MARKER, start + START_MARKER.length) !== -1 ||
    content.indexOf(END_MARKER, end + END_MARKER.length) !== -1
  ) {
    throw new Error("shell profile contains a damaged Cinba PATH marker block");
  }
  return { start, end: end + END_MARKER.length };
}

async function readProfile(path: string): Promise<{ content: string; mode: number } | undefined> {
  try {
    const file = await lstat(path);
    if (file.isSymbolicLink()) {
      return undefined;
    }
    if (!file.isFile()) {
      throw new Error(`shell profile is not a regular file: ${path}`);
    }
    return { content: await readFile(path, "utf8"), mode: file.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { content: "", mode: 0o600 };
    }
    throw error;
  }
}

async function writeProfile(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.cinba-tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function appendManagedBlock(content: string): string {
  const withoutTrailingBlankLines = content.replace(/[\t ]*(?:\r?\n)*$/, "");
  return withoutTrailingBlankLines.length > 0
    ? `${withoutTrailingBlankLines}\n\n${MANAGED_BLOCK}\n`
    : `${MANAGED_BLOCK}\n`;
}

export async function configurePosixLauncherPath(options: {
  homeDirectory: string;
  launcherDirectory: string;
  currentPath: string;
  shell: string;
}): Promise<PosixPathConfiguration> {
  if (!isAbsolute(options.homeDirectory) || !isAbsolute(options.launcherDirectory)) {
    throw new Error("POSIX PATH configuration requires absolute home and launcher directories");
  }
  const expected = resolve(options.homeDirectory, ".local", "bin");
  if (resolve(options.launcherDirectory) !== expected) {
    throw new Error("Cinba POSIX launcher directory must be ~/.local/bin");
  }
  if (pathEntries(options.currentPath).some((entry) => resolve(entry) === expected)) {
    return { state: "already-available" };
  }
  const profilePath = profileForShell(options.homeDirectory, options.shell);
  if (!profilePath) {
    return {
      state: "manual",
      instruction: `Add ${options.launcherDirectory} to PATH for ${basename(options.shell) || "your shell"}.`,
    };
  }
  const profile = await readProfile(profilePath);
  if (!profile) {
    return {
      state: "manual",
      instruction: `Add ${options.launcherDirectory} to PATH; ${profilePath} is a symbolic link and was not changed.`,
    };
  }
  const range = markerRange(profile.content);
  const content = range
    ? `${profile.content.slice(0, range.start)}${MANAGED_BLOCK}${profile.content.slice(range.end)}`
    : appendManagedBlock(profile.content);
  await writeProfile(profilePath, content, profile.mode);
  return { state: "profile-updated", profilePath };
}

export async function removePosixLauncherPathBlock(profilePath: string): Promise<boolean> {
  if (!isAbsolute(profilePath)) {
    throw new Error("shell profile path must be absolute");
  }
  const profile = await readProfile(profilePath);
  if (!profile) {
    throw new Error("symbolic-link shell profiles are not managed by Cinba");
  }
  const range = markerRange(profile.content);
  if (!range) {
    return false;
  }
  const before = profile.content.slice(0, range.start).replace(/[\t ]*\r?\n$/, "");
  const after = profile.content.slice(range.end).replace(/^\r?\n/, "");
  const content = `${before}${before && after ? "\n" : ""}${after}`;
  await writeProfile(profilePath, content, profile.mode);
  return true;
}
