// The React adapter for a Cinba Core connection.
//
// CoreClient reports callbacks; React renders state. This hook owns the mirror
// ledger and translates between those two shapes so the page does not have to.

import { useEffect, useRef, useState } from "react";
import { CoreClient } from "@cinba/core-client";
import type { CoreConnectionState } from "@cinba/core-client";
import { createSession } from "@cinba/contract";
import type {
  ModelRef,
  ProviderStatus,
  Session,
  SessionSummary,
  Snapshot,
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
  const [coreName, setCoreName] = useState("");
  const [connectionState, setConnectionState] =
    useState<CoreConnectionState>("connecting");

  const clientRef = useRef<CoreClient | undefined>(undefined);
  const mirrorRef = useRef<Session>(createSession());

  useEffect(() => {
    let active = true;

    const client = new CoreClient(serverUrl, {
      onConnectionChanged: (state) => {
        if (active) setConnectionState(state);
      },
      onSnapshot: (state) => {
        mirrorRef.current = createSession(state.snapshot);
        setSnapshot(state.snapshot);
        setCwd(state.cwd);
        setModel(state.model);
        setSessionId(state.sessionId);
      },
      onActions: (actions) => {
        for (const action of actions) mirrorRef.current.apply(action);
        setSnapshot(mirrorRef.current.snapshot());
      },
      onDirListing: setListing,
      onModelListing: setModels,
      onModelChanged: setModel,
      onSessionListing: setSessions,
      onSessionOpened: setSessionId,
      onProviderListing: setProviders,
      onCoreIdentity: setCoreName,
    });
    clientRef.current = client;

    return () => {
      active = false;
      clientRef.current = undefined;
      client.close();
    };
  }, [serverUrl]);

  return {
    client: clientRef.current,
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
  };
}
