import { useEffect, useState } from "react";
import { type CoreConnectionState } from "@cinba/core-client";
import { type ContextUsage, type Snapshot, agentActivity } from "@cinba/contract";

function contextLabel(context: ContextUsage): string {
  if (context.contextWindow === null) {
    return "Context unavailable";
  }
  const used = context.tokens === null ? "—" : context.tokens.toLocaleString("en-US");
  const percent = context.percent === null ? "—" : `${Math.round(context.percent)}%`;
  return `Context ${context.estimated ? "~" : ""}${used}/${context.contextWindow.toLocaleString("en-US")} (${percent})`;
}

export function StatusBar({
  snapshot,
  connectionState,
  onCompact,
  onAbort,
  onAbortRetry,
}: {
  snapshot: Snapshot;
  connectionState: CoreConnectionState;
  onCompact: () => void;
  onAbort: () => void;
  onAbortRetry: () => void;
}) {
  const activity = agentActivity(snapshot);
  const retryAt = activity.type === "retrying" ? activity.retryAt : undefined;
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (retryAt === undefined) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [retryAt]);

  let activityLabel = "Idle · Ready";
  if (connectionState === "connecting") {
    activityLabel = "Connecting to core";
  } else if (connectionState === "disconnected") {
    activityLabel = "Reconnecting to core";
  } else {
    switch (activity.type) {
      case "permission":
        activityLabel = `Waiting for permission · ${activity.toolName}`;
        break;
      case "compacting":
        activityLabel = "Compacting context";
        break;
      case "retrying": {
        const seconds =
          now === 0
            ? Math.ceil(activity.delayMs / 1_000)
            : Math.max(0, Math.ceil((activity.retryAt - now) / 1_000));
        activityLabel = `Retrying ${activity.attempt}/${activity.maxAttempts} in ${seconds}s · ${activity.errorMessage}`;
        break;
      }
      case "tool":
        activityLabel = `Running ${activity.toolName}`;
        break;
      case "answering":
        activityLabel = "Answering";
        break;
    }
  }

  const pendingCount = snapshot.queue.steering.length + snapshot.queue.followUp.length;
  if (pendingCount > 0) {
    activityLabel += ` · ${pendingCount} queued`;
  }

  let contextClass = "status-context";
  if (snapshot.context.percent !== null && snapshot.context.percent >= 75) {
    contextClass += " context-warning";
  }
  if (snapshot.context.percent !== null && snapshot.context.percent >= 90) {
    contextClass += " context-critical";
  }

  return (
    <div className="status-bar">
      <div className="status-resources">
        <span className={contextClass}>{contextLabel(snapshot.context)}</span>
        <span>Session {snapshot.totalTokens.toLocaleString("en-US")} tokens</span>
        <span>${snapshot.totalCost.toFixed(4)}</span>
      </div>
      <output
        className={`status-activity ${activity.type}`}
        title={activityLabel}
        aria-live="polite"
      >
        {activityLabel}
      </output>
      <div className="status-actions">
        {connectionState === "connected" && activity.type === "retrying" ? (
          <button onClick={onAbortRetry}>Stop retrying</button>
        ) : null}
        {connectionState === "connected" &&
        activity.type !== "idle" &&
        activity.type !== "retrying" ? (
          <button onClick={onAbort}>Stop</button>
        ) : null}
        {connectionState === "connected" && activity.type === "idle" ? (
          <button onClick={onCompact}>Compact</button>
        ) : null}
      </div>
    </div>
  );
}
