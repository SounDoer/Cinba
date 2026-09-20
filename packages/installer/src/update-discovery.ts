import { type ProductTarget } from "./platform.ts";
import { type ReleaseArtifact, type ReleaseManifest, parseReleaseManifest } from "./manifest.ts";
import { RELEASE_MANIFEST_FILE_NAME } from "./product-release-constants.ts";
import {
  type DetectedSystem,
  detectCurrentSystem,
  systemMeetsArtifactMinimum,
} from "./system-compatibility.ts";
import { type UpdateCandidate, parseUpdateState } from "./update-state.ts";

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

type AvailableUpdate = Extract<UpdateDiscovery, { state: "available" }>;
export type UpdateDiscoveryFailure = "system-incompatible" | "system-unverified";
export const UPDATE_DISCOVERY_FAILURE_CODE = "CINBA_UPDATE_DISCOVERY_FAILURE";
export const UPDATE_RATE_LIMIT_CODE = "CINBA_UPDATE_RATE_LIMITED";
/** A reset further out than this is not a quota Cinba should wait for. */
export const MAX_UPDATE_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;
const MAX_UPDATE_DISCOVERY_FAILURE_MESSAGE_LENGTH = 2_048;
const UPDATE_DISCOVERY_FAILURE_FIELDS = new Set(["code", "failure", "candidate", "message"]);

export type UpdateDiscoveryFailureDetails = {
  readonly code: typeof UPDATE_DISCOVERY_FAILURE_CODE;
  readonly failure: UpdateDiscoveryFailure;
  readonly candidate: Readonly<UpdateCandidate>;
  readonly message: string;
};

function candidateFrom(update: AvailableUpdate): UpdateCandidate {
  return {
    version: update.latestVersion,
    revision: update.manifest.revision,
    target: update.artifact.target,
    artifactPath: null,
    size: update.artifact.size,
    sha256: update.artifact.sha256,
    releaseUrl: update.releaseUrl,
  };
}

export class UpdateDiscoveryFailureError extends Error {
  readonly code = UPDATE_DISCOVERY_FAILURE_CODE;
  readonly failure: UpdateDiscoveryFailure;
  readonly candidate: UpdateCandidate;

  constructor(
    failure: UpdateDiscoveryFailure,
    update: AvailableUpdate,
    message: string,
    options?: ErrorOptions,
  ) {
    super(
      (message || "Cinba update compatibility could not be determined.").slice(
        0,
        MAX_UPDATE_DISCOVERY_FAILURE_MESSAGE_LENGTH,
      ),
      options,
    );
    Object.defineProperty(this, "name", {
      value: "UpdateDiscoveryFailureError",
      configurable: true,
      writable: true,
    });
    this.failure = failure;
    this.candidate = candidateFrom(update);
  }
}

/** Rate limiting is transient, so it carries the moment a later check may run instead. */
export class UpdateRateLimitError extends Error {
  readonly code = UPDATE_RATE_LIMIT_CODE;
  readonly retryAfter: string | null;

  constructor(message: string, retryAfter: string | null) {
    super(message);
    Object.defineProperty(this, "name", {
      value: "UpdateRateLimitError",
      configurable: true,
      writable: true,
    });
    this.retryAfter = retryAfter;
  }
}

export function parseUpdateRateLimit(value: unknown): { retryAfter: string | null } | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const { code, retryAfter } = value as { code?: unknown; retryAfter?: unknown };
  if (code !== UPDATE_RATE_LIMIT_CODE) {
    return undefined;
  }
  if (retryAfter === null || retryAfter === undefined) {
    return { retryAfter: null };
  }
  if (
    typeof retryAfter !== "string" ||
    !retryAfter.endsWith("Z") ||
    Number.isNaN(Date.parse(retryAfter))
  ) {
    return undefined;
  }
  return { retryAfter };
}

function dataValue(descriptors: PropertyDescriptorMap, field: string): unknown {
  const descriptor = descriptors[field];
  if (!descriptor || !Object.hasOwn(descriptor, "value")) {
    throw new Error(`update discovery failure ${field} must be an own data property`);
  }
  return descriptor.value;
}

export function parseUpdateDiscoveryFailure(
  value: unknown,
): Readonly<UpdateDiscoveryFailureDetails> | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Object.entries(descriptors).some(
        ([field, descriptor]) =>
          descriptor.enumerable && !UPDATE_DISCOVERY_FAILURE_FIELDS.has(field),
      )
    ) {
      return undefined;
    }
    const code = dataValue(descriptors, "code");
    const failure = dataValue(descriptors, "failure");
    const candidateValue = dataValue(descriptors, "candidate");
    const message = dataValue(descriptors, "message");
    if (
      code !== UPDATE_DISCOVERY_FAILURE_CODE ||
      (failure !== "system-incompatible" && failure !== "system-unverified") ||
      typeof message !== "string" ||
      message.length < 1 ||
      message.length > MAX_UPDATE_DISCOVERY_FAILURE_MESSAGE_LENGTH
    ) {
      return undefined;
    }
    const state = parseUpdateState({
      schemaVersion: 1,
      phase: "failed",
      currentVersion: "0.0.0",
      checkedAt: "1970-01-01T00:00:00.000Z",
      candidate: candidateValue,
      failure,
    });
    const candidate = Object.freeze({ ...state.candidate! });
    return Object.freeze({ code, failure, candidate, message });
  } catch {
    return undefined;
  }
}

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

export function compareStableVersions(left: string, right: string): number {
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

/** GitHub answers an exhausted quota with 403 or 429 and its rate-limit headers. */
function isRateLimited(response: Response): boolean {
  return (
    (response.status === 403 || response.status === 429) &&
    (response.headers.get("x-ratelimit-remaining")?.trim() === "0" ||
      response.headers.has("retry-after"))
  );
}

/** Milliseconds for a header holding whole seconds, or NaN when it holds something else. */
function seconds(value: string | null): number {
  return value !== null && /^\d+$/.test(value.trim()) ? Number(value.trim()) * 1_000 : Number.NaN;
}

/** Retry-After is a delay in seconds or an HTTP date; X-RateLimit-Reset is epoch seconds. */
function resetMoment(headers: Headers, now: Date): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter === null) {
    return seconds(headers.get("x-ratelimit-reset"));
  }
  const delay = seconds(retryAfter);
  return Number.isNaN(delay) ? Date.parse(retryAfter) : now.getTime() + delay;
}

/** The moment the quota returns, as an ISO timestamp, or null when GitHub did not say. */
function rateLimitRetryAfter(headers: Headers, now: Date): string | null {
  const resetsAt = resetMoment(headers, now);
  // An absent or implausible reset leaves the usual check interval in charge.
  if (
    !Number.isFinite(resetsAt) ||
    resetsAt <= now.getTime() ||
    resetsAt > now.getTime() + MAX_UPDATE_RETRY_AFTER_MS
  ) {
    return null;
  }
  return new Date(resetsAt).toISOString();
}

function rateLimitFailure(response: Response, now: Date): UpdateRateLimitError {
  const retryAfter = rateLimitRetryAfter(response.headers, now);
  const limit = response.headers.get("x-ratelimit-limit")?.trim();
  const quota = limit && /^\d+$/.test(limit) ? `, ${limit} requests per hour` : "";
  return new UpdateRateLimitError(
    `GitHub is rate limiting anonymous requests from this network (HTTP ${response.status}${quota}). ${
      retryAfter
        ? `The limit resets at ${new Date(retryAfter).toLocaleString()}; check again after that.`
        : "Check again later."
    }`,
    retryAfter,
  );
}

function responseFailure(response: Response, context: string, notFound: string, now: Date): Error {
  if (isRateLimited(response)) {
    return rateLimitFailure(response, now);
  }
  if (response.status === 403) {
    return new Error(
      `${context} was forbidden (HTTP 403); a proxy, firewall, or GitHub restriction is blocking this network.`,
    );
  }
  if (response.status === 404) {
    return new Error(notFound);
  }
  return new Error(`${context} request failed with HTTP ${response.status}`);
}

async function jsonResponse(
  response: Response,
  context: string,
  notFound: string,
  maximumBytes: number,
) {
  if (!response.ok) {
    throw responseFailure(response, context, notFound, new Date());
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

function minimumSystemDescription(artifact: ReleaseArtifact): string {
  if (artifact.target === "windows-x64") {
    return `Windows ${artifact.minimumSystem.version}`;
  }
  if (artifact.target === "macos-arm64") {
    return `macOS ${artifact.minimumSystem.version}`;
  }
  return `Linux kernel ${artifact.minimumSystem.kernel} and glibc ${artifact.minimumSystem.glibc}`;
}

function detectedSystemDescription(system: DetectedSystem): string {
  if (system.platform === "windows") {
    return `Windows version ${system.version}`;
  }
  if (system.platform === "macos") {
    return `macOS version ${system.version}`;
  }
  return `Linux kernel ${system.kernel} and glibc ${system.glibc}`;
}

function validDottedVersion(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/.test(value);
}

function isDetectedSystem(value: unknown, target: ProductTarget): value is DetectedSystem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const system = value as Record<string, unknown>;
  if (target === "windows-x64") {
    return system.platform === "windows" && validDottedVersion(system.version);
  }
  if (target === "macos-arm64") {
    return system.platform === "macos" && validDottedVersion(system.version);
  }
  return (
    system.platform === "linux-gnu" &&
    validDottedVersion(system.kernel) &&
    validDottedVersion(system.glibc)
  );
}

/** Node's fetch reports every network failure as "fetch failed"; the reason is in its cause. */
function networkFailureDetail(error: unknown): string {
  let cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
  // A refused connection to several addresses arrives as an AggregateError without a message.
  if (cause instanceof AggregateError && !cause.message && cause.errors.length > 0) {
    cause = cause.errors[0];
  }
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (!cause.message) {
      return code ?? cause.name;
    }
    return code && !cause.message.includes(code) ? `${code}: ${cause.message}` : cause.message;
  }
  return String(cause);
}

/** Names what could not be reached and why; a cancellation stays the caller's own abort error. */
export function networkFailure(
  message: string,
  error: unknown,
  signal: AbortSignal | null | undefined,
): unknown {
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
    return error;
  }
  return new Error(`${message} (${networkFailureDetail(error)}).`, { cause: error });
}

async function fetchReleaseResource(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetcher(url, init);
  } catch (error) {
    throw networkFailure(
      "Cinba could not reach GitHub Releases to check for updates",
      error,
      init.signal,
    );
  }
}

export async function discoverCinbaUpdate(options: {
  currentVersion: string;
  currentRevision: string;
  target: ProductTarget;
  fetch?: typeof fetch;
  signal?: AbortSignal;
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
      await fetchReleaseResource(fetcher, CINBA_RELEASE_API, {
        headers,
        redirect: "error",
        ...(options.signal ? { signal: options.signal } : {}),
      }),
      "GitHub latest release",
      "GitHub has no published Cinba release yet (HTTP 404); the newest release may still be a draft.",
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
      await fetchReleaseResource(fetcher, manifestUrl, {
        headers,
        redirect: "follow",
        ...(options.signal ? { signal: options.signal } : {}),
      }),
      "Cinba release manifest",
      `${CINBA_RELEASE_MANIFEST_ASSET} is missing from its GitHub release (HTTP 404).`,
      1_000_000,
    ),
  );
  if (release.tagName !== `v${manifest.version}`) {
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
  const comparison = compareStableVersions(manifest.version, options.currentVersion);
  if (comparison <= 0) {
    return {
      state: "current",
      currentVersion: options.currentVersion,
      latestVersion: manifest.version,
      releaseUrl: release.htmlUrl,
    };
  }
  const update: AvailableUpdate = {
    state: "available",
    currentVersion: options.currentVersion,
    latestVersion: manifest.version,
    releaseUrl: release.htmlUrl,
    manifest,
    artifact,
    downloadUrl,
  };
  let system: DetectedSystem;
  try {
    const detected: unknown = await (options.probeSystem ?? detectCurrentSystem)(options.target);
    if (!isDetectedSystem(detected, options.target)) {
      throw new Error("system probe returned unsupported output");
    }
    system = detected;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new UpdateDiscoveryFailureError(
      "system-unverified",
      update,
      `Cinba ${manifest.version} compatibility is unknown: could not verify ${minimumSystemDescription(artifact)} requirements (${detail}).`,
      { cause: error },
    );
  }
  if (!systemMeetsArtifactMinimum(artifact, system)) {
    throw new UpdateDiscoveryFailureError(
      "system-incompatible",
      update,
      `Current ${detectedSystemDescription(system)} cannot install Cinba ${manifest.version}; it requires ${minimumSystemDescription(artifact)} or newer.`,
    );
  }
  return update;
}
