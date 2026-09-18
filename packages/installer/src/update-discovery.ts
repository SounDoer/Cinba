import { type ProductTarget } from "./platform.ts";
import { type ReleaseArtifact, type ReleaseManifest, parseReleaseManifest } from "./manifest.ts";
import { RELEASE_MANIFEST_FILE_NAME } from "./product-release-constants.ts";
import {
  type DetectedSystem,
  detectCurrentSystem,
  systemMeetsArtifactMinimum,
} from "./system-compatibility.ts";

export const CINBA_RELEASE_API = "https://api.github.com/repos/SounDoer/Cinba/releases/latest";
export const CINBA_RELEASE_MANIFEST_ASSET = RELEASE_MANIFEST_FILE_NAME;

type GitHubAsset = {
  name: string;
  size: number;
  digest: string | null;
  browserDownloadUrl: string;
};

type GitHubRelease = {
  tagName: string;
  htmlUrl: string;
  draft: boolean;
  prerelease: boolean;
  immutable: boolean;
  publishedAt: string;
  assets: GitHubAsset[];
};

export type UpdateDiscovery =
  | {
      state: "current";
      currentVersion: string;
      latestVersion: string;
      releaseUrl: string;
    }
  | {
      state: "available";
      currentVersion: string;
      latestVersion: string;
      releaseUrl: string;
      manifest: ReleaseManifest;
      artifact: ReleaseArtifact;
      downloadUrl: string;
    };

function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function parseAsset(value: unknown, index: number): GitHubAsset {
  const parsed = record(value, `GitHub release assets[${index}]`);
  if (!Number.isSafeInteger(parsed.size) || (parsed.size as number) < 1) {
    throw new Error(`GitHub release assets[${index}].size must be a positive integer`);
  }
  if (parsed.digest !== null && parsed.digest !== undefined && typeof parsed.digest !== "string") {
    throw new Error(`GitHub release assets[${index}].digest must be a string or null`);
  }
  return {
    name: requiredString(parsed.name, `GitHub release assets[${index}].name`),
    size: parsed.size as number,
    digest: (parsed.digest as string | null | undefined) ?? null,
    browserDownloadUrl: requiredString(
      parsed.browser_download_url,
      `GitHub release assets[${index}].browser_download_url`,
    ),
  };
}

function parseGitHubRelease(value: unknown): GitHubRelease {
  const parsed = record(value, "GitHub latest release");
  if (
    typeof parsed.draft !== "boolean" ||
    typeof parsed.prerelease !== "boolean" ||
    typeof parsed.immutable !== "boolean" ||
    !Array.isArray(parsed.assets)
  ) {
    throw new Error("GitHub latest release fields are invalid");
  }
  return {
    tagName: requiredString(parsed.tag_name, "GitHub latest release tag_name"),
    htmlUrl: requiredString(parsed.html_url, "GitHub latest release html_url"),
    draft: parsed.draft,
    prerelease: parsed.prerelease,
    immutable: parsed.immutable,
    publishedAt: requiredString(parsed.published_at, "GitHub latest release published_at"),
    assets: parsed.assets.map(parseAsset),
  };
}

function requireReleaseDownloadUrl(urlValue: string, tag: string, fileName: string): string {
  const url = new URL(urlValue);
  const expectedPath = `/SounDoer/Cinba/releases/download/${tag}/${fileName}`;
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.pathname !== expectedPath) {
    throw new Error(`${fileName} download URL does not belong to the selected Cinba release`);
  }
  return url.toString();
}

function stableVersionParts(value: string): [number, number, number] {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) {
    throw new Error(`stable updates require a release SemVer, received ${value}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemVer(left: string, right: string): number {
  const leftParts = stableVersionParts(left);
  const rightParts = stableVersionParts(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

async function jsonResponse(response: Response, context: string, maximumBytes: number) {
  if (!response.ok) {
    throw new Error(`${context} request failed with HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new Error(`${context} response exceeds ${maximumBytes} bytes`);
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error(`${context} response is not valid JSON`);
  }
}

export async function discoverCinbaUpdate(options: {
  currentVersion: string;
  currentRevision: string;
  target: ProductTarget;
  fetch?: typeof fetch;
  probeSystem?: (target: ProductTarget) => Promise<DetectedSystem>;
}): Promise<UpdateDiscovery> {
  stableVersionParts(options.currentVersion);
  const fetcher = options.fetch ?? fetch;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": `Cinba/${options.currentVersion}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const release = parseGitHubRelease(
    await jsonResponse(
      await fetcher(CINBA_RELEASE_API, { headers, redirect: "error" }),
      "GitHub latest release",
      1_000_000,
    ),
  );
  if (release.draft || release.prerelease || !release.immutable) {
    throw new Error("GitHub latest release is not an immutable stable release");
  }
  const manifestAsset = release.assets.find((asset) => asset.name === CINBA_RELEASE_MANIFEST_ASSET);
  if (!manifestAsset) {
    throw new Error(`GitHub latest release is missing ${CINBA_RELEASE_MANIFEST_ASSET}`);
  }
  const manifestUrl = requireReleaseDownloadUrl(
    manifestAsset.browserDownloadUrl,
    release.tagName,
    manifestAsset.name,
  );
  const manifest = parseReleaseManifest(
    await jsonResponse(
      await fetcher(manifestUrl, { headers, redirect: "follow" }),
      "Cinba release manifest",
      1_000_000,
    ),
  );
  if (release.tagName !== `v${manifest.version}` || release.publishedAt !== manifest.publishedAt) {
    throw new Error("GitHub release identity does not match its manifest");
  }
  if (
    manifest.version === options.currentVersion &&
    manifest.revision !== options.currentRevision
  ) {
    throw new Error("the installed version and GitHub release have different revisions");
  }
  const artifact = manifest.artifacts.find((candidate) => candidate.target === options.target)!;
  const asset = release.assets.find((candidate) => candidate.name === artifact.fileName);
  if (!asset || asset.size !== artifact.size) {
    throw new Error(`GitHub release asset ${artifact.fileName} is missing or has the wrong size`);
  }
  if (asset.digest !== null && asset.digest !== `sha256:${artifact.sha256}`) {
    throw new Error(`GitHub release asset ${artifact.fileName} has the wrong digest`);
  }
  const downloadUrl = requireReleaseDownloadUrl(
    asset.browserDownloadUrl,
    release.tagName,
    artifact.fileName,
  );
  const comparison = compareSemVer(manifest.version, options.currentVersion);
  if (comparison <= 0) {
    return {
      state: "current",
      currentVersion: options.currentVersion,
      latestVersion: manifest.version,
      releaseUrl: release.htmlUrl,
    };
  }
  let system: DetectedSystem;
  try {
    system = await (options.probeSystem ?? detectCurrentSystem)(options.target);
  } catch (error) {
    throw new Error("A new Cinba version exists, but system compatibility is unverifiable", {
      cause: error,
    });
  }
  if (!systemMeetsArtifactMinimum(artifact, system)) {
    throw new Error("A new Cinba version exists, but this system is incompatible");
  }
  return {
    state: "available",
    currentVersion: options.currentVersion,
    latestVersion: manifest.version,
    releaseUrl: release.htmlUrl,
    manifest,
    artifact,
    downloadUrl,
  };
}
