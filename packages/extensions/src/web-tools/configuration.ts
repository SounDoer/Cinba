import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createWebToolsCredentialStore } from "./credentials.ts";
import type { WebSearchPrimary } from "./types.ts";

export type WebSearchConfiguration = {
  primary: WebSearchPrimary;
  apiKeys: { exa?: string; brave?: string };
};

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
  const directory = stateDirectory(environment);
  let primary: WebSearchPrimary = "auto";
  try {
    const parsed = JSON.parse(readFileSync(join(directory, "config.json"), "utf8")) as Record<
      string,
      unknown
    >;
    if (parsed.webSearchPrimary === "exa" || parsed.webSearchPrimary === "brave") {
      primary = parsed.webSearchPrimary;
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
