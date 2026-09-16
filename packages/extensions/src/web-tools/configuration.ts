import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createWebToolsCredentialStore } from "./credentials.ts";
import type { WebSearchPrimary } from "./types.ts";

export type WebSearchConfiguration = {
  primary: WebSearchPrimary;
  apiKeys: { exa?: string; brave?: string };
};

export const WEB_TOOLS_RUNTIME_CONFIG_ENV = "CINBA_WEB_TOOLS_RUNTIME_CONFIG";

function readRuntimeConfiguration(path: string): WebSearchConfiguration {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Web tools runtime configuration must be an object");
  }
  const document = parsed as Record<string, unknown>;
  if (document.version !== 1) {
    throw new Error("Unsupported Web tools runtime configuration version");
  }
  if (typeof document.webTools !== "object" || document.webTools === null) {
    throw new Error("Web tools runtime configuration is missing webTools");
  }
  const webTools = document.webTools as Record<string, unknown>;
  if (
    webTools.searchPrimary !== "auto" &&
    webTools.searchPrimary !== "exa" &&
    webTools.searchPrimary !== "brave"
  ) {
    throw new Error("Web tools runtime configuration has an invalid search primary");
  }
  if (
    typeof webTools.apiKeys !== "object" ||
    webTools.apiKeys === null ||
    Array.isArray(webTools.apiKeys)
  ) {
    throw new Error("Web tools runtime configuration is missing apiKeys");
  }
  const apiKeys = webTools.apiKeys as Record<string, unknown>;
  if (apiKeys.exa !== undefined && typeof apiKeys.exa !== "string") {
    throw new Error("Web tools runtime configuration has an invalid Exa key");
  }
  if (apiKeys.brave !== undefined && typeof apiKeys.brave !== "string") {
    throw new Error("Web tools runtime configuration has an invalid Brave key");
  }
  return {
    primary: webTools.searchPrimary,
    apiKeys: {
      ...(typeof apiKeys.exa === "string" && apiKeys.exa !== "" ? { exa: apiKeys.exa } : {}),
      ...(typeof apiKeys.brave === "string" && apiKeys.brave !== ""
        ? { brave: apiKeys.brave }
        : {}),
    },
  };
}

function stateDirectory(environment: NodeJS.ProcessEnv): string {
  const configured = environment.CINBA_STATE_DIR?.trim();
  if (!configured) {
    return join(homedir(), ".cinba");
  }
  if (!isAbsolute(configured)) {
    throw new Error("CINBA_STATE_DIR must be an absolute path");
  }
  return resolve(configured);
}

export function loadWebSearchConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): WebSearchConfiguration {
  const runtimePath = environment[WEB_TOOLS_RUNTIME_CONFIG_ENV]?.trim();
  if (runtimePath) {
    if (!isAbsolute(runtimePath)) {
      throw new Error(`${WEB_TOOLS_RUNTIME_CONFIG_ENV} must be an absolute path`);
    }
    return readRuntimeConfiguration(runtimePath);
  }

  const directory = stateDirectory(environment);
  let primary: WebSearchPrimary = "auto";
  try {
    const parsed = JSON.parse(
      readFileSync(join(directory, "local-settings.json"), "utf8"),
    ) as Record<string, unknown>;
    const webTools = parsed.webTools as Record<string, unknown> | undefined;
    if (webTools?.searchPrimary === "exa" || webTools?.searchPrimary === "brave") {
      primary = webTools.searchPrimary;
    }
  } catch {
    // Missing and malformed ordinary configuration both use safe defaults.
  }
  const credentials = createWebToolsCredentialStore(
    join(directory, "credentials.json"),
    environment,
  );
  return {
    primary,
    apiKeys: {
      exa: credentials.getApiKey("exa"),
      brave: credentials.getApiKey("brave"),
    },
  };
}
