// 界面入口：连服务器、维护镜像账本、渲染。
//
// 这份代码同时服务于浏览器与 Electron 窗口——两边加载的是同一个页面。

import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createSession, RemoteSession } from "@cinba/core-client";
import type { Session, Snapshot } from "@cinba/core-client";
import { Transcript } from "./Transcript.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";
import type { Listing } from "./ProjectPicker.tsx";
import "./style.css";

const EMPTY: Snapshot = { entries: [], totalTokens: 0, totalCost: 0, busy: false };

/** 页面从哪来就连回哪去，所以浏览器与 Electron 都不用配置地址。 */
const SERVER_URL = `ws://${location.host}/ws`;

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [cwd, setCwd] = useState("");
  const [draft, setDraft] = useState("");
  const [picking, setPicking] = useState(false);
  const [listing, setListing] = useState<Listing | undefined>(undefined);

  const remoteRef = useRef<RemoteSession | undefined>(undefined);
  const mirrorRef = useRef<Session>(createSession());
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const socket = new WebSocket(SERVER_URL);

    remoteRef.current = new RemoteSession(socket, {
      onSnapshot: (next, nextCwd) => {
        mirrorRef.current = createSession(next);
        setSnapshot(next);
        setCwd(nextCwd);
      },
      onActions: (actions) => {
        for (const action of actions) mirrorRef.current.apply(action);
        setSnapshot(mirrorRef.current.snapshot());
      },
      onReset: (nextCwd) => setCwd(nextCwd),
      onDirListing: (next) => setListing(next),
    });

    return () => socket.close();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [snapshot]);

  // Esc 中止。必须挂在 window 上，不能挂在输入框上——回答期间输入框是 disabled 的，
  // 禁用的元素收不到键盘事件。阶段 1b 的 GUI 踩过这个坑。
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && snapshot.busy) {
        event.preventDefault();
        remoteRef.current?.abort();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [snapshot.busy]);

  function send() {
    const text = draft.trim();
    if (snapshot.busy || text === "") return;
    setDraft("");
    remoteRef.current?.prompt(text);
  }

  return (
    <>
      <header>
        <button onClick={() => setPicking(true)}>
          项目：{cwd.split(/[\\/]/).pop() || "…"}
        </button>
        <span>
          {snapshot.totalTokens} tokens · ${snapshot.totalCost.toFixed(4)}
        </span>
      </header>

      <main id="transcript">
        <Transcript
          entries={snapshot.entries}
          onRespond={(requestId, confirmed) =>
            remoteRef.current?.respondConfirm(requestId, confirmed)
          }
        />
        <div ref={bottomRef} />
      </main>

      <footer>
        <textarea
          rows={3}
          placeholder="说点什么（Enter 发送，Shift+Enter 换行）"
          value={draft}
          disabled={snapshot.busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        <button onClick={send} disabled={snapshot.busy}>
          发送
        </button>
        {snapshot.busy ? <button onClick={() => remoteRef.current?.abort()}>中止</button> : null}
      </footer>

      {picking ? (
        <ProjectPicker
          remote={remoteRef.current}
          listing={listing}
          startPath={cwd}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </>
  );
}

// 热更新会重新执行本模块，而同一个容器不能重复 createRoot——
// 复用已有的 root，否则开发时会出现「点了没反应」这类状态错乱。
const container = document.getElementById("root")!;
const globals = globalThis as { __cinbaRoot?: ReturnType<typeof createRoot> };
globals.__cinbaRoot ??= createRoot(container);
globals.__cinbaRoot.render(<App />);
