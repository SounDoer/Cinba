import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type WebSearchCredentialProviderId = "exa" | "brave";

export type WebToolsCredentialStatus = {
  configured: boolean;
  source?: "environment" | "stored";
  hasStoredCredential: boolean;
};

export type WebToolsCredentialStore = {
  clearApiKey(provider: WebSearchCredentialProviderId): void;
  getApiKey(provider: WebSearchCredentialProviderId): string | undefined;
  getCredentialStatus(provider: WebSearchCredentialProviderId): WebToolsCredentialStatus;
  setApiKey(provider: WebSearchCredentialProviderId, apiKey: string): void;
};

function readCredentialDocument(path: string): Record<string, unknown> | undefined {
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error("Credentials file contains malformed JSON", { cause: error });
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function readWebTools(document: Record<string, unknown>): Record<string, unknown> {
  const webTools = document.webTools;
  if (typeof webTools !== "object" || webTools === null) {
    return {};
  }
  return webTools as Record<string, unknown>;
}

function readStoredApiKey(
  path: string,
  provider: WebSearchCredentialProviderId,
): string | undefined {
  const document = readCredentialDocument(path);
  if (!document) {
    return undefined;
  }
  const credential = readWebTools(document)[provider];
  if (typeof credential !== "object" || credential === null) {
    return undefined;
  }
  const apiKey = (credential as Record<string, unknown>).apiKey;
  return typeof apiKey === "string" && apiKey !== "" ? apiKey : undefined;
}

function writeCredentialDocument(path: string, document: Record<string, unknown>): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, JSON.stringify(document, null, 2), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created or may already have been renamed.
    }
    throw error;
  }
}

export function createWebToolsCredentialStore(
  path: string,
  environment: NodeJS.ProcessEnv = process.env,
): WebToolsCredentialStore {
  function getApiKey(provider: WebSearchCredentialProviderId): string | undefined {
    return (
      environment[provider === "exa" ? "EXA_API_KEY" : "BRAVE_SEARCH_API_KEY"] ??
      readStoredApiKey(path, provider)
    );
  }

  return {
    clearApiKey: (provider) => {
      const document = readCredentialDocument(path);
      if (!document) {
        return;
      }
      const webTools = { ...readWebTools(document) };
      delete webTools[provider];
      writeCredentialDocument(path, { ...document, webTools });
    },
    getApiKey,
    getCredentialStatus: (provider) => {
      const storedApiKey = readStoredApiKey(path, provider);
      const environmentKey =
        environment[provider === "exa" ? "EXA_API_KEY" : "BRAVE_SEARCH_API_KEY"];
      if (environmentKey) {
        return {
          configured: true,
          source: "environment",
          hasStoredCredential: storedApiKey !== undefined,
        };
      }
      if (storedApiKey !== undefined) {
        return {
          configured: true,
          source: "stored",
          hasStoredCredential: true,
        };
      }
      return {
        configured: false,
        hasStoredCredential: false,
      };
    },
    setApiKey: (provider, apiKey) => {
      const trimmedApiKey = apiKey.trim();
      if (trimmedApiKey === "") {
        throw new Error("API key must not be empty");
      }
      const document = readCredentialDocument(path) ?? {};
      const webTools = readWebTools(document);
      writeCredentialDocument(path, {
        ...document,
        webTools: { ...webTools, [provider]: { apiKey: trimmedApiKey } },
      });
    },
  };
}
