// The React adapter for a Cinba Core connection.
//
// CoreClient reports callbacks; React renders state. This hook owns the mirror
// ledger and translates between those two shapes so the page does not have to.

import { useCallback, useEffect, useRef, useState } from "react";
import { CoreClient, type CoreConnectionState } from "@cinba/core-client";
import {
  type ModelRef,
  type ProviderStatus,
  type Session,
  type SessionSummary,
  type Snapshot,
  type WebSearchCredentialProviderId,
  type WebSearchPrimary,
  type WebToolsStatus,
  createSession,
} from "@cinba/contract";

export type DirectoryListing = {
  path: string;
  parent: string | null;
  dirs: string[];
};

const EMPTY: Snapshot = { entries: [], totalTokens: 0, totalCost: 0, busy: false };

export function useCore(serverUrl: string) {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [cwd, setCwd] = useState("");
  const [listing, setListing] = useState<DirectoryListing | undefined>(undefined);
  const [model, setModel] = useState<ModelRef | undefined>(undefined);
  const [models, setModels] = useState<ModelRef[] | undefined>(undefined);
  const [sessionId, setSessionId] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[] | undefined>(undefined);
  const [providers, setProviders] = useState<ProviderStatus[] | undefined>(undefined);
  const [webToolsStatus, setWebToolsStatus] = useState<WebToolsStatus | undefined>(undefined);
  const [webToolsError, setWebToolsError] = useState<string | undefined>(undefined);
  const [coreName, setCoreName] = useState("");
  const [connectionState, setConnectionState] = useState<CoreConnectionState>("connecting");

  const clientRef = useRef<CoreClient | undefined>(undefined);
  const mirrorRef = useRef<Session>(createSession());

  useEffect(() => {
    let active = true;

    const client = new CoreClient(
      serverUrl,
      {
        onConnectionChanged: (state) => {
          if (active) {
            setConnectionState(state);
          }
        },
        onSnapshot: (state) => {
          mirrorRef.current = createSession(state.snapshot);
          setSnapshot(state.snapshot);
          setCwd(state.cwd);
          setModel(state.model);
          setSessionId(state.sessionId);
        },
        onActions: (actions) => {
          for (const action of actions) {
            mirrorRef.current.apply(action);
          }
          setSnapshot(mirrorRef.current.snapshot());
        },
        onDirListing: setListing,
        onModelListing: setModels,
        onModelChanged: setModel,
        onSessionListing: setSessions,
        onSessionOpened: setSessionId,
        onProviderListing: setProviders,
        onWebToolsStatus: (status, error) => {
          setWebToolsStatus(status);
          setWebToolsError(error);
        },
        onCoreIdentity: setCoreName,
      },
      { autoReconnect: true },
    );
    clientRef.current = client;

    return () => {
      active = false;
      clientRef.current = undefined;
      client.close();
    };
  }, [serverUrl]);

  const withClient = useCallback((operation: (client: CoreClient) => boolean): boolean => {
    const client = clientRef.current;
    return client ? operation(client) : false;
  }, []);

  const prompt = useCallback(
    (text: string) => withClient((client) => client.prompt(text)),
    [withClient],
  );
  const editMessage = useCallback(
    (entryId: string, text: string) => withClient((client) => client.editMessage(entryId, text)),
    [withClient],
  );
  const abort = useCallback(() => withClient((client) => client.abort()), [withClient]);
  const respondConfirm = useCallback(
    (requestId: string, confirmed: boolean) =>
      withClient((client) => client.respondConfirm(requestId, confirmed)),
    [withClient],
  );
  const listDirectory = useCallback(
    (path: string) => withClient((client) => client.listDir(path)),
    [withClient],
  );
  const listModels = useCallback(() => withClient((client) => client.listModels()), [withClient]);
  const selectModel = useCallback(
    (next: ModelRef) => withClient((client) => client.setModel(next.provider, next.id)),
    [withClient],
  );
  const listSessions = useCallback(
    (directory?: string) => withClient((client) => client.listSessions(directory)),
    [withClient],
  );
  const openSession = useCallback(
    (id: string) => withClient((client) => client.openSession(id)),
    [withClient],
  );
  const createConversation = useCallback(
    (directory: string) => withClient((client) => client.createSession(directory)),
    [withClient],
  );
  const deleteSession = useCallback(
    (id: string) => withClient((client) => client.deleteSession(id)),
    [withClient],
  );
  const renameSession = useCallback(
    (name: string) => withClient((client) => client.renameSession(name)),
    [withClient],
  );
  const listProviders = useCallback(
    () => withClient((client) => client.listProviders()),
    [withClient],
  );
  const setApiKey = useCallback(
    (providerId: string, apiKey: string) =>
      withClient((client) => client.setApiKey(providerId, apiKey)),
    [withClient],
  );
  const clearCredential = useCallback(
    (providerId: string) => withClient((client) => client.clearCredential(providerId)),
    [withClient],
  );
  const getWebToolsStatus = useCallback(() => {
    setWebToolsError(undefined);
    return withClient((client) => client.getWebToolsStatus());
  }, [withClient]);
  const setWebToolsApiKey = useCallback(
    (providerId: WebSearchCredentialProviderId, apiKey: string) => {
      setWebToolsError(undefined);
      return withClient((client) => client.setWebToolsApiKey(providerId, apiKey));
    },
    [withClient],
  );
  const clearWebToolsApiKey = useCallback(
    (providerId: WebSearchCredentialProviderId) => {
      setWebToolsError(undefined);
      return withClient((client) => client.clearWebToolsApiKey(providerId));
    },
    [withClient],
  );
  const setWebSearchPrimary = useCallback(
    (primary: WebSearchPrimary) => {
      setWebToolsError(undefined);
      return withClient((client) => client.setWebSearchPrimary(primary));
    },
    [withClient],
  );

  return {
    connectionState,
    connected: connectionState === "connected",
    coreName,
    snapshot,
    cwd,
    listing,
    model,
    models,
    sessionId,
    sessions,
    providers,
    webToolsStatus,
    webToolsError,
    prompt,
    editMessage,
    abort,
    respondConfirm,
    listDirectory,
    listModels,
    selectModel,
    listSessions,
    openSession,
    createConversation,
    deleteSession,
    renameSession,
    listProviders,
    setApiKey,
    clearCredential,
    getWebToolsStatus,
    setWebToolsApiKey,
    clearWebToolsApiKey,
    setWebSearchPrimary,
  };
}
