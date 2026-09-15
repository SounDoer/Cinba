// Resolve project resource trust before Pi starts, while a real client can still answer.

import {
  type ProjectTrustInspection,
  inspectProjectTrust,
  rememberProjectTrust,
} from "@cinba/agent";

export type ProjectTrustRequest = {
  requestId: string;
  cwd: string;
  resources: string[];
};

export type ProjectTrustResult = { proceed: false } | { proceed: true; projectTrusted?: boolean };

export type ProjectTrustGate<Requester> = {
  ensure(cwd: string, requester: Requester): Promise<ProjectTrustResult>;
  respond(requester: Requester, requestId: string, trusted: boolean): boolean;
  cancel(requester: Requester): void;
};

export type ProjectTrustGateOptions<Requester> = {
  inspect?: (cwd: string) => ProjectTrustInspection;
  remember?: (cwd: string, trusted: boolean) => void;
  request(requester: Requester, value: ProjectTrustRequest): void;
};

type Pending<Requester> = {
  requester: Requester;
  cwd: string;
  requestId: string;
  promise: Promise<ProjectTrustResult>;
  resolve: (result: ProjectTrustResult) => void;
};

export function createProjectTrustGate<Requester>(
  options: ProjectTrustGateOptions<Requester>,
): ProjectTrustGate<Requester> {
  const inspect = options.inspect ?? inspectProjectTrust;
  const remember = options.remember ?? rememberProjectTrust;
  const byId = new Map<string, Pending<Requester>>();
  const byDirectory = new Map<string, Pending<Requester>>();
  let nextId = 0;

  async function ensure(cwd: string, requester: Requester): Promise<ProjectTrustResult> {
    const inspection = inspect(cwd);
    if (!inspection.required) {
      return { proceed: true };
    }
    if (inspection.decision !== null) {
      return { proceed: true, projectTrusted: inspection.decision };
    }

    const existing = byDirectory.get(cwd);
    if (existing) {
      return existing.promise;
    }

    nextId += 1;
    const requestId = `project-trust-${nextId}`;
    let resolve!: (result: ProjectTrustResult) => void;
    const promise = new Promise<ProjectTrustResult>((done) => {
      resolve = done;
    });
    const pending: Pending<Requester> = { requester, cwd, requestId, promise, resolve };
    byId.set(requestId, pending);
    byDirectory.set(cwd, pending);
    options.request(requester, { requestId, cwd, resources: inspection.resources });
    return promise;
  }

  function finish(pending: Pending<Requester>, result: ProjectTrustResult): void {
    byId.delete(pending.requestId);
    byDirectory.delete(pending.cwd);
    pending.resolve(result);
  }

  function respond(requester: Requester, requestId: string, trusted: boolean): boolean {
    const pending = byId.get(requestId);
    if (!pending || pending.requester !== requester) {
      return false;
    }
    remember(pending.cwd, trusted);
    finish(pending, { proceed: true, projectTrusted: trusted });
    return true;
  }

  function cancel(requester: Requester): void {
    for (const pending of byId.values()) {
      if (pending.requester === requester) {
        finish(pending, { proceed: false });
      }
    }
  }

  return { ensure, respond, cancel };
}
